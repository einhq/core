/**
 * Settling a finished pooled step is two writes in two stores — the step node in
 * the VFS, the job in the pool registry — and they cannot share a transaction.
 * One of them lands first, and the choice is not symmetric:
 *
 *  - step written, job not: the job stays `claimed` with nobody heartbeating it,
 *    the pool's sweep reclaims it, and the next claimer drops it because
 *    `staleReason` sees a step that is no longer `waiting`. Self-healing.
 *  - job written, step not: the step sits `running` with no lease to expire and
 *    no job to reclaim, holding an `advanceLocks` slot until the engine restarts.
 *
 * So the invariant is step first, pool last, in *both* outcomes, and the pool
 * release is retried so the self-healing case stays rare too. These tests drive
 * `PoolWorker` against a real `MemoryPoolRegistry` and a VFS stub that can be
 * told to make the pool write fail, which is the fault the ordering exists for.
 */

import { PIPELINE_INSTANCES_PATH, POOLS_PATH } from '../../../lib/paths.ts';
import { assert, assertEquals } from '@std/assert';
import { STEP_EXIT_INPUT, STEP_EXIT_TEMPORARY } from '../../../lib/step-exit.ts';
import { join } from '@std/path';
import { endRests, PoolWorker } from '../pool-worker.ts';
import { MemoryPoolRegistry } from '../../../registries/pool/mod.ts';
import type { PoolFailOptions, PoolJob, PoolJobId } from '../../../registries/pool/mod.ts';
import type { NodeVFS } from '../../../vfs/node-vfs.ts';
import type { RunAndCaptureOptions, RunAndCaptureResult, TtyIf } from '../../exec/types.ts';
import type { PipelineInstanceAttrs, PipelineStepAttrs, PoolJobParams } from '../types.ts';

const POOL_ID = 'settlepool';
const POOL_PATH = `${POOLS_PATH}/settlepool`;
const INSTANCE = `${PIPELINE_INSTANCES_PATH}/test-settle/01`;
const STEP = 'heavy';
const STEP_PATH = join(INSTANCE, 'steps', STEP);

/** Just enough VFS for `PoolWorker`: node attrs in a Map, pool ops on a real registry. */
class SettleVfs {
  readonly nodes = new Map<string, Record<string, unknown>>();
  /** Set to make every pool write throw, as a database blip would. */
  failRelease = 0;
  releaseCalls = 0;

  constructor(private reg: MemoryPoolRegistry) {}

  // deno-lint-ignore no-explicit-any
  get(_access: unknown, path: string): Promise<any> {
    const attrs = this.nodes.get(path);
    if (!attrs) throw new Error(`no node: ${path}`);
    return Promise.resolve({ id: `id:${path}`, attrs });
  }

  update(_access: unknown, path: string, patch: { attrs: Record<string, unknown> }): Promise<void> {
    const attrs = this.nodes.get(path);
    if (!attrs) throw new Error(`no node: ${path}`);
    // `undefined` in a patch clears, matching how the step attrs are written.
    for (const [key, value] of Object.entries(patch.attrs)) {
      if (value === undefined) delete attrs[key];
      else attrs[key] = value;
    }
    return Promise.resolve();
  }

  exists(): Promise<boolean> {
    return Promise.resolve(false); // no bashrc, so the worker sources nothing
  }

  ensure(): Promise<void> {
    return Promise.resolve();
  }

  poolClaim(_a: unknown, _p: string, req: Parameters<MemoryPoolRegistry['claim']>[1], signal?: AbortSignal): Promise<PoolJob | null> {
    return this.reg.claim(POOL_ID, req, signal);
  }

  poolHeartbeat(_a: unknown, _p: string, jobId: PoolJobId, owner: string, leaseMs?: number): Promise<boolean> {
    return this.reg.heartbeat(POOL_ID, jobId, owner, leaseMs);
  }

  poolComplete(_a: unknown, _p: string, jobId: PoolJobId, owner: string, result?: unknown): Promise<PoolJob | null> {
    return this.release(() => this.reg.complete(POOL_ID, jobId, owner, result));
  }

  poolFail(_a: unknown, _p: string, jobId: PoolJobId, owner: string, error: string, opts?: PoolFailOptions): Promise<PoolJob | null> {
    return this.release(() => this.reg.fail(POOL_ID, jobId, owner, error, opts));
  }

  poolRelease(_a: unknown, _p: string, jobId: PoolJobId, owner: string, delayMs?: number): Promise<PoolJob | null> {
    return this.release(() => this.reg.release(POOL_ID, jobId, owner, delayMs));
  }

  private release(write: () => Promise<PoolJob | null>): Promise<PoolJob | null> {
    this.releaseCalls++;
    if (this.failRelease > 0) {
      this.failRelease--;
      return Promise.reject(new Error('pool write failed'));
    }
    return write();
  }
}

/** A tty that reports one fixed exit code for whatever step command it is given. */
function fixedExitTty(code: number): TtyIf {
  return {
    runAndCapture: () => Promise.resolve({ code, stdout: '', stderr: code === 0 ? '' : 'boom' }),
  } as unknown as TtyIf;
}

type Scenario = {
  exitCode: number;
  maxAttempts?: number;
  failRelease?: number;
};

/** Run one job through a worker and return the settled step attrs and job. */
async function settle(scenario: Scenario): Promise<{ step: PipelineStepAttrs; job: PoolJob | null; releaseCalls: number }> {
  const reg = new MemoryPoolRegistry();
  await reg.init();
  await reg.touch(POOL_ID, { leaseMs: 60_000, backoffMs: 50 });

  const vfs = new SettleVfs(reg);
  vfs.nodes.set(INSTANCE, { status: 'running', triggerPath: INSTANCE } satisfies Partial<PipelineInstanceAttrs> as Record<string, unknown>);
  vfs.nodes.set(STEP_PATH, { status: 'waiting', dependsOn: [], command: 'step', pool: POOL_ID } as Record<string, unknown>);

  const added = await reg.add(POOL_ID, {
    kind: STEP,
    dedupKey: STEP_PATH,
    maxAttempts: scenario.maxAttempts ?? 3,
    params: { instancePath: INSTANCE, stepName: STEP, command: 'step' } satisfies PoolJobParams,
  });

  const worker = new PoolWorker(vfs as unknown as NodeVFS, fixedExitTty(scenario.exitCode), {
    poolPath: POOL_PATH,
    concurrency: 1,
  });

  vfs.failRelease = scenario.failRelease ?? 0;
  await worker.start();

  // The step flips status before the release is even attempted, so waiting on it
  // alone would stop the worker mid-retry and let `stop()` hand the job back
  // itself. Wait for the release attempts to stop coming instead.
  const deadline = Date.now() + 15_000;
  let quietSince = Date.now();
  let seen = vfs.releaseCalls;

  while (Date.now() - quietSince < 600) {
    if (Date.now() > deadline) throw new Error('step never settled');
    await new Promise((r) => setTimeout(r, 20));
    if (vfs.releaseCalls !== seen) {
      seen = vfs.releaseCalls;
      quietSince = Date.now();
    }
  }

  await worker.stop();
  const job = await reg.get(POOL_ID, added.id);
  await reg.dispose();

  return { step: vfs.nodes.get(STEP_PATH) as unknown as PipelineStepAttrs, job, releaseCalls: vfs.releaseCalls };
}

Deno.test('a successful step releases its pool job even when the first release fails', async () => {
  const { step, job, releaseCalls } = await settle({ exitCode: 0, failRelease: 1 });

  assertEquals(step.status, 'completed');
  assertEquals(job?.state, 'done');
  assertEquals(releaseCalls, 2); // retried rather than leaving a claimed job behind
});

Deno.test('a release that keeps failing leaks the job, never the step', async () => {
  const { step, job } = await settle({ exitCode: 0, failRelease: 99 });

  // The tolerated direction: the step is terminal and the job is left for the
  // pool's lease sweep. The reverse — a `running` step with a `done` job — is
  // what nothing reclaims, so it must not be reachable.
  assertEquals(step.status, 'completed');
  assertEquals(job?.state, 'claimed');
});

Deno.test('a failing step that still has attempts left is recorded before the job is handed back', async () => {
  const { step, job } = await settle({ exitCode: 3, maxAttempts: 3, failRelease: 99 });

  assertEquals(step.status, 'waiting');
  assertEquals(step.exitCode, 3);
  assertEquals(job?.state, 'claimed');
  // A retry reads as one: the run it had, and a wait timed from that run's end, not from its start.
  assertEquals(step.attempts, 1);
  assertEquals(step.startedAt, undefined);
  assertEquals(typeof step.waitingSince, 'number');
});

Deno.test('a failing step with no attempts left is recorded before the job is handed back', async () => {
  const { step, job } = await settle({ exitCode: 3, maxAttempts: 1, failRelease: 99 });

  assertEquals(step.status, 'failed');
  assertEquals(step.exitCode, 3);
  assertEquals(job?.state, 'claimed');
});

Deno.test('a step whose service could not do it yet waits again without spending an attempt', async () => {
  const before = Date.now();
  const { step, job } = await settle({ exitCode: STEP_EXIT_TEMPORARY, maxAttempts: 1 });

  // Its only attempt was not spent: EMS busy or down is not the step failing.
  assertEquals(step.status, 'waiting');
  assertEquals(step.attempts, 0);
  assertEquals(step.exitCode, STEP_EXIT_TEMPORARY);
  assertEquals(job?.state, 'ready');
  assertEquals(job?.attempts, 0);
  // Handed back for after its pause, not at once.
  assert(job!.availableAt.getTime() >= before + 30_000);
});

/**
 * A worker that names `STEP` as its kind, over one job per command in `commands`, each its own
 * instance. `exitOf` says how a command's run ends; it is read on every run. The jobs at
 * `refusedBefore` start out as handed back once already by this worker, as if their pause had run.
 */
async function kindWorker(commands: string[], exitOf: (command: string) => number, refusedBefore: number[] = []) {
  const reg = new MemoryPoolRegistry();
  await reg.init();
  await reg.touch(POOL_ID, { leaseMs: 60_000, backoffMs: 50 });
  const vfs = new SettleVfs(reg);

  const jobs: { id: PoolJobId; stepPath: string }[] = [];
  for (const [i, command] of commands.entries()) {
    const instance = `${PIPELINE_INSTANCES_PATH}/test-settle/k${i}`;
    const stepPath = join(instance, 'steps', STEP);
    vfs.nodes.set(instance, { status: 'running', triggerPath: instance } satisfies Partial<PipelineInstanceAttrs> as Record<string, unknown>);
    vfs.nodes.set(stepPath, { status: 'waiting', dependsOn: [], command: `step-${command}`, pool: POOL_ID } as Record<string, unknown>);
    const added = await reg.add(POOL_ID, {
      kind: STEP,
      dedupKey: stepPath,
      maxAttempts: 1,
      params: { instancePath: instance, stepName: STEP, command: `step-${command}` } satisfies PoolJobParams,
    });
    jobs.push({ id: added.id, stepPath });
  }

  const tty = {
    runAndCapture: (line: string) => {
      const command = commands.find((c) => line.includes(`step-${c}`)) ?? '';
      return Promise.resolve({ code: exitOf(command), stdout: '', stderr: '' });
    },
  } as unknown as TtyIf;
  const worker = new PoolWorker(vfs as unknown as NodeVFS, tty, { poolPath: POOL_PATH, kinds: [STEP], concurrency: 1 });
  const jobPauses = (worker as unknown as { jobPauses: Map<PoolJobId, { ms: number; at: number }> }).jobPauses;
  for (const i of refusedBefore) jobPauses.set(jobs[i].id, { ms: 30_000, at: Date.now() - 30_000 });
  await worker.start();

  const step = (i: number) => vfs.nodes.get(jobs[i].stepPath) as unknown as PipelineStepAttrs;
  const until = async (what: string, done: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 10_000;
    while (!(await done())) {
      if (Date.now() > deadline) throw new Error(`never: ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const dispose = async () => {
    await worker.stop();
    await reg.dispose();
  };
  return { reg, worker, jobs, step, until, dispose };
}

Deno.test("a refused job waits its own pause while the kind's other jobs run", async () => {
  const before = Date.now();
  const { reg, worker, jobs, step, until, dispose } = await kindWorker(
    ['needs-card', 'plain-1', 'plain-2'],
    (command) => command === 'needs-card' ? STEP_EXIT_TEMPORARY : 0,
  );
  try {
    await until('the other jobs complete', () => step(1).status === 'completed' && step(2).status === 'completed');
    // The refused job is back in line for after its pause, its attempt given back, and the kind
    // does not rest for it.
    const held = (await reg.get(POOL_ID, jobs[0].id))!;
    assertEquals(held.state, 'ready');
    assertEquals(held.attempts, 0);
    assert(held.availableAt.getTime() >= before + 30_000);
    assertEquals(step(0).status, 'waiting');
    assertEquals(worker.state().resting, {});
  } finally {
    await dispose();
  }
});

Deno.test("five refusals in a row rest the kind, and waking it runs the kind's other jobs", async () => {
  let down = true;
  const commands = ['s0', 's1', 's2', 's3', 's4', 's5'];
  const { reg, worker, jobs, step, until, dispose } = await kindWorker(commands, () => down ? STEP_EXIT_TEMPORARY : 0);
  try {
    await until('the kind rests', () => worker.state().resting[STEP] !== undefined);
    // Five were refused and wait out their own pauses; the sixth is left for the rest to end.
    const states = await Promise.all(jobs.map(async ({ id }) => (await reg.get(POOL_ID, id))!.availableAt.getTime() > Date.now()));
    assertEquals(states, [true, true, true, true, true, false]);

    down = false;
    assertEquals(endRests(), [{ pool: POOL_PATH, kind: STEP }]);
    await until("the kind's next job runs and completes", () => step(5).status === 'completed');
    assertEquals(worker.state().resting, {});
    assertEquals(step(0).status, 'waiting');
  } finally {
    await dispose();
  }
});

Deno.test('a completed step clears the count of refusals in a row', async () => {
  // Refused, refused, done, then four more refused: never five in a row, so the kind never rests.
  const commands = ['r0', 'r1', 'ok', 'r2', 'r3', 'r4', 'r5'];
  const { step, worker, until, dispose } = await kindWorker(commands, (command) => command === 'ok' ? 0 : STEP_EXIT_TEMPORARY);
  try {
    await until('every job has run once', () => commands.every((_, i) => step(i).exitCode !== undefined));
    assertEquals(worker.state().resting, {});
  } finally {
    await dispose();
  }
});

Deno.test('a job refused before does not count toward resting the kind', async () => {
  // Five refused in a row, but four of them were refused before: their own need, already known.
  const commands = ['again-0', 'again-1', 'again-2', 'again-3', 'fresh'];
  const { step, worker, until, dispose } = await kindWorker(commands, () => STEP_EXIT_TEMPORARY, [0, 1, 2, 3]);
  try {
    await until('every job has run once', () => commands.every((_, i) => step(i).exitCode !== undefined));
    assertEquals(worker.state().resting, {});
  } finally {
    await dispose();
  }
});

Deno.test('the count of refusals starts over when the kind rests', async () => {
  const commands = ['s0', 's1', 's2', 's3', 's4', 's5'];
  const { step, worker, until, dispose } = await kindWorker(commands, () => STEP_EXIT_TEMPORARY);
  try {
    await until('the kind rests', () => worker.state().resting[STEP] !== undefined);
    endRests({ kinds: [STEP] });
    // The sixth is the first refusal after the rest, not the sixth in a row.
    await until('the sixth job has run', () => step(5).exitCode !== undefined);
    assertEquals(worker.state().resting, {});
  } finally {
    await dispose();
  }
});

Deno.test('waking other kinds leaves a rest alone, and naming the kind ends it', async () => {
  const { worker, until, dispose } = await kindWorker(['s0', 's1', 's2', 's3', 's4'], () => STEP_EXIT_TEMPORARY);
  try {
    await until('the kind rests', () => worker.state().resting[STEP] !== undefined);
    assertEquals(endRests({ kinds: ['another-kind'] }), []);
    assert(worker.state().resting[STEP] !== undefined);
    assertEquals(endRests({ kinds: [STEP] }), [{ pool: POOL_PATH, kind: STEP }]);
  } finally {
    await dispose();
  }
});

Deno.test('a step that fails on its input fails at once, whatever attempts are left', async () => {
  const { step, job } = await settle({ exitCode: STEP_EXIT_INPUT, maxAttempts: 5 });

  assertEquals(step.status, 'failed');
  assertEquals(step.cause, 'input');
  assertEquals(job?.state, 'failed');
});

Deno.test('the pool has the last word when its retry boundary disagrees', async () => {
  const { step, job } = await settle({ exitCode: 3, maxAttempts: 1 });

  assertEquals(step.status, 'failed');
  assertEquals(job?.state, 'failed');
});

/**
 * A worker holding one claimed, running step whose command behaves like a real one: it ends
 * with 143 when the capture is hung up, and records that it was.
 */
async function startHanging(opts: { maxAttempts?: number; leaseMs?: number } = {}) {
  const reg = new MemoryPoolRegistry();
  await reg.init();
  await reg.touch(POOL_ID, { leaseMs: 60_000, backoffMs: 0 });

  const vfs = new SettleVfs(reg);
  vfs.nodes.set(INSTANCE, { status: 'running', triggerPath: INSTANCE } satisfies Partial<PipelineInstanceAttrs> as Record<string, unknown>);
  vfs.nodes.set(STEP_PATH, { status: 'waiting', dependsOn: [], command: 'step', pool: POOL_ID } as Record<string, unknown>);

  const added = await reg.add(POOL_ID, {
    kind: STEP,
    dedupKey: STEP_PATH,
    maxAttempts: opts.maxAttempts ?? 3,
    params: { instancePath: INSTANCE, stepName: STEP, command: 'step' } satisfies PoolJobParams,
  });

  const hungUp = Promise.withResolvers<void>();
  const tty = {
    runAndCapture: (_script: string, _ctx?: unknown, captureOpts: RunAndCaptureOptions = {}) =>
      new Promise<RunAndCaptureResult>((resolve) => {
        captureOpts.signal?.addEventListener('abort', () => {
          hungUp.resolve();
          resolve({ code: 143, stdout: '', stderr: 'terminated' });
        }, { once: true });
      }),
  } as unknown as TtyIf;

  const worker = new PoolWorker(vfs as unknown as NodeVFS, tty, { poolPath: POOL_PATH, concurrency: 1, leaseMs: opts.leaseMs });
  await worker.start();

  const deadline = Date.now() + 5_000;
  while ((vfs.nodes.get(STEP_PATH) as unknown as PipelineStepAttrs).status !== 'running') {
    if (Date.now() > deadline) throw new Error('worker never started the step');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  return { reg, vfs, worker, jobId: added.id, hungUp: hungUp.promise, step: () => vfs.nodes.get(STEP_PATH) as unknown as PipelineStepAttrs };
}

Deno.test('stopping a worker hangs up its running step, then restores it before returning the job', async () => {
  const { reg, worker, jobId, hungUp, step } = await startHanging();
  let stopped = false;

  try {
    await worker.stop().then(() => stopped = true);
    await hungUp;

    assertEquals(stopped, true);
    assertEquals(step().status, 'waiting');
    assertEquals(step().startedAt, undefined);
    // The hang-up is the stop, not a failure of the step.
    assertEquals(step().exitCode, undefined);
    assertEquals((await reg.get(POOL_ID, jobId))?.state, 'ready');
  } finally {
    await reg.dispose();
  }
});

Deno.test('a step on its last attempt is not failed by the worker stopping', async () => {
  const { reg, worker, jobId, step } = await startHanging({ maxAttempts: 1 });

  try {
    await worker.stop();

    assertEquals(step().status, 'waiting');
    assertEquals(step().error, undefined);
    assertEquals(step().exitCode, undefined);
    // The step's count gives back the attempt with the job, so it does not read as a retry.
    assertEquals(step().attempts, 0);
    // Handed back, not failed: claimable at once, with its one attempt still to come.
    const job = await reg.get(POOL_ID, jobId);
    assertEquals(job?.state, 'ready');
    assertEquals(job?.attempts, 0);
  } finally {
    await reg.dispose();
  }
});

Deno.test('losing the lease hangs up the running step', async () => {
  // A lease of 3 s heartbeats every second; the cancel makes the next heartbeat find it gone.
  const { reg, worker, hungUp, step } = await startHanging({ leaseMs: 3_000 });

  try {
    assertEquals(await reg.cancel(POOL_ID, { dedupKey: STEP_PATH }), 1);
    await hungUp;

    // The new owner, if any, drives the step: the old run writes nothing.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertEquals(step().status, 'running');
    assertEquals(step().exitCode, undefined);
  } finally {
    await worker.stop();
    await reg.dispose();
  }
});
