/**
 * An instance the engine can never finish is worse than a slow one: it holds an
 * `advanceLocks` entry, and `advanceLocks` is what the admission gate counts.
 * Enough of them and the engine admits nothing at all.
 *
 * Two ways in, one covered per step below:
 *
 *  - a pooled step left `running` by a worker whose job is gone. Nothing holds a
 *    lease, so the pool's sweep never reclaims it, and read at face value the
 *    status would call the step in flight forever. Its milder cousin, the job
 *    requeued by that sweep, is covered too: nothing is lost, but the step must
 *    say `waiting` again, or the next worker drops the job as stale.
 *  - an instance whose `steps` were never written. The empty-steps guard exists
 *    for a real create-time race, but it cannot tell "not yet" from "never".
 *
 * No worker runs against the pool here, so a repaired step comes to rest at
 * `waiting` with a live job — that, not execution, is what is being asserted.
 */

import { PIPELINE_INSTANCES_PATH, POOLS_PATH } from '../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { join } from '@std/path';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../../vfs/types/directory.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import type { PipelineInstanceAttrs, PipelineStepAttrs } from '../types.ts';

const TEST_MIME = 'application/x-pool-orphan';
const POOL = `${POOLS_PATH}/orphanpool`;
const INSTANCES = `${PIPELINE_INSTANCES_PATH}/test-pool-orphan`;

/**
 * Short enough that the unattended repair is observable inside a test (the default is a
 * minute); the point of overriding it is that the repair must not need a hand.
 */
const SWEEP_MS = 1500;

const harness = new SystemTestHarness({
  ssh: false,
  boot: true,
  env: { CFG_PIPELINE_STUCK_SWEEP_MS: String(SWEEP_MS) },
});

/** A predicate that throws counts as "not yet" — the nodes it reads are being created under it. */
async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      if (await predicate()) return;
    } catch { /* not there yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

Deno.test({
  name: 'an instance that cannot progress is repaired instead of holding its admission slot',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await harness.startPrimary();
  const client = await harness.createShellClient();

  const writeFile = async (path: string, body: string): Promise<void> => {
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(body + '\n'));
    } finally {
      await handle.close();
    }
  };

  const liveJobs = async (stepPath: string): Promise<number> => (await vfs.poolJobs(ADMIN_ACCESS, POOL, { state: ['ready', 'claimed'], dedupKey: stepPath })).length;

  try {
    await client.exec('mkdir -p /work');
    await client.exec('mkfile /work/test-pool-orphan.yaml');
    await writeFile(
      '/work/test-pool-orphan.yaml',
      [
        'name: test-pool-orphan',
        'trigger:',
        '  event: updated',
        '  nodeType: file',
        '  match:',
        `    mimetype: ${TEST_MIME}`,
        'steps:',
        '  heavy:',
        // Never runs: nothing claims this pool for the length of the test.
        '    command: pool-never $NODE_PATH',
        '    pool: orphanpool',
        '    kind: heavy',
      ].join('\n'),
    );
    assertEquals((await client.exec('pipeline define /work/test-pool-orphan.yaml')).success, true);

    await t.step('a pooled step whose job vanished is re-queued', async () => {
      await client.exec(`mknode -t file --as "name=a.bin" --as "mimetype=${TEST_MIME}" /work/a.bin`);
      await client.exec('chmod 644 /work/a.bin');

      await waitFor(async () => (await vfs.children(ADMIN_ACCESS, INSTANCES)).length === 1, 'the instance');
      const [instance] = await vfs.children(ADMIN_ACCESS, INSTANCES);
      const stepPath = join(INSTANCES, instance.name, 'steps', 'heavy');

      await waitFor(async () => await liveJobs(stepPath) === 1, 'the step to be pooled');
      // Pooled is not started: the wait in the pool is timed apart from execution.
      const pooled = (await vfs.get<PipelineStepAttrs>(ADMIN_ACCESS, stepPath)).attrs;
      assertEquals(pooled.startedAt, undefined);
      assertEquals(typeof pooled.waitingSince, 'number');

      // Exactly the state a worker leaves behind when it dies with its job: the
      // step claimed and marked `running`, and nothing in the pool to sweep.
      // Written in that order so no advance in flight sees `waiting` with no job
      // and repairs it through the pre-existing `waiting` path instead.
      await vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, stepPath, { attrs: { status: 'running', startedAt: Date.now() } });
      await waitFor(async () => (await vfs.get<PipelineStepAttrs>(ADMIN_ACCESS, stepPath)).attrs.status === 'running', 'the step to read running');
      assertEquals(await vfs.poolCancel(ADMIN_ACCESS, POOL, { dedupKey: stepPath }), 1);

      // Nudge an advance without touching the status, standing in for the
      // `kickOpenInstances` pass.
      await vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, stepPath, { attrs: { startedAt: Date.now() } });

      await waitFor(async () => await liveJobs(stepPath) === 1, 'the lost job to be restored');
      assertEquals((await vfs.get<PipelineStepAttrs>(ADMIN_ACCESS, stepPath)).attrs.status, 'waiting');
      // Repaired back into the pool, so the instance is live but nothing is executing: the job
      // is queued and unclaimed.
      assertEquals((await vfs.get<PipelineInstanceAttrs>(ADMIN_ACCESS, join(INSTANCES, instance.name))).attrs.status, 'queued');
    });

    await t.step('an orphan is repaired without anyone touching it', async () => {
      // The repair runs on its own clock, not only when the admission gate is saturated.
      // Nothing here nudges the instance; the engine's own sweep has to find it.
      await client.exec(`mknode -t file --as "name=c.bin" --as "mimetype=${TEST_MIME}" /work/c.bin`);
      await client.exec('chmod 644 /work/c.bin');

      const path = join(INSTANCES, 'orphan-unattended');
      await waitFor(async () => (await vfs.children(ADMIN_ACCESS, INSTANCES)).length >= 2, 'the second instance');
      const found = (await vfs.children(ADMIN_ACCESS, INSTANCES)).find((entry) => join(INSTANCES, entry.name) !== path);
      const stepPath = join(INSTANCES, found!.name, 'steps', 'heavy');

      await waitFor(async () => await liveJobs(stepPath) === 1, 'its job');
      await vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, stepPath, { attrs: { status: 'running', startedAt: Date.now() } });

      // Let the advance this update triggers run to completion *before* the job disappears.
      // Otherwise that advance is what repairs the orphan and the sweep is never tested — the
      // ordering the pre-existing case above is also careful about.
      await new Promise((r) => setTimeout(r, 1000));
      assertEquals(await vfs.poolCancel(ADMIN_ACCESS, POOL, { dedupKey: stepPath }), 1);
      assertEquals(await liveJobs(stepPath), 0);

      // Nothing touches the instance from here. Only the engine's own sweep can restore it.
      await waitFor(
        async () => await liveJobs(stepPath) === 1,
        'the sweep to restore the lost job unaided',
        SWEEP_MS * 10,
      );
    });

    await t.step('a restored job takes its kind from the definition as it is now', async () => {
      // A kind renamed under queued work: `pool cancel --kind <old>` clears the jobs, and the
      // repair must re-add them under the new name — restoring the instance's snapshot would
      // put them straight back where nothing claims them.
      await writeFile(
        '/work/test-pool-orphan.yaml',
        [
          'name: test-pool-orphan',
          'trigger:',
          '  event: updated',
          '  nodeType: file',
          '  match:',
          `    mimetype: ${TEST_MIME}`,
          'steps:',
          '  heavy:',
          '    command: pool-never $NODE_PATH',
          '    pool: orphanpool',
          '    kind: heavy-renamed',
          '    requires:',
          '      slots: 1',
        ].join('\n'),
      );
      assertEquals((await client.exec('pipeline define /work/test-pool-orphan.yaml')).success, true);

      const [instance] = await vfs.children(ADMIN_ACCESS, INSTANCES);
      const stepPath = join(INSTANCES, instance.name, 'steps', 'heavy');
      assertEquals((await vfs.get<PipelineStepAttrs>(ADMIN_ACCESS, stepPath)).attrs.kind, 'heavy');
      // Both instances above are still waiting under the old kind.
      assertEquals(await vfs.poolCancel(ADMIN_ACCESS, POOL, { kind: 'heavy' }), 2);

      await waitFor(async () => await liveJobs(stepPath) === 1, 'the job to be restored under the new kind', SWEEP_MS * 10);
      const [job] = await vfs.poolJobs(ADMIN_ACCESS, POOL, { state: ['ready', 'claimed'], dedupKey: stepPath });
      assertEquals(job.kind, 'heavy-renamed');
      assertEquals(job.requires, { slots: 1 });
      // The snapshot converges, so the instance page and the next repair agree with the pool.
      const repaired = (await vfs.get<PipelineStepAttrs>(ADMIN_ACCESS, stepPath)).attrs;
      assertEquals(repaired.kind, 'heavy-renamed');
      assertEquals(repaired.requires, { slots: 1 });
    });

    await t.step('a live pooled step is left alone', async () => {
      // Claimed as a worker claims it, with a lease that outlasts the test, and marked `running`
      // as that worker would. The pool owns it, and the engine must not double-book by re-queueing.
      const job = await vfs.poolClaim(ADMIN_ACCESS, POOL, { owner: 'test-live', offer: { slots: 1 }, leaseMs: 10 * 60_000 });
      const stepPath = job!.dedupKey!;
      const instancePath = join(stepPath, '..', '..');

      await vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, stepPath, { attrs: { status: 'running', startedAt: Date.now() } });
      await new Promise((r) => setTimeout(r, SWEEP_MS * 2));

      assertEquals((await vfs.get<PipelineStepAttrs>(ADMIN_ACCESS, stepPath)).attrs.status, 'running');
      assertEquals(await liveJobs(stepPath), 1);

      // The other half of the queued/running split: a step a worker has claimed IS execution,
      // so the instance reads 'running'. Pinned next to the queued case above because the two
      // differ only in whether the job is claimed, and that is the whole distinction.
      await waitFor(
        async () => (await vfs.get<PipelineInstanceAttrs>(ADMIN_ACCESS, instancePath)).attrs.status === 'running',
        'the instance to read running while its step is claimed',
      );
    });

    await t.step('a step whose worker died goes back to waiting once its job is requeued', async () => {
      // The other instance's job, claimed by a worker that then dies: its lease lapses, the
      // pool's sweep puts the job back to `ready`, and the step still says `running`.
      const job = await vfs.poolClaim(ADMIN_ACCESS, POOL, { owner: 'test-dead', offer: { slots: 1 }, leaseMs: 1 });
      const stepPath = job!.dedupKey!;
      const instancePath = join(stepPath, '..', '..');

      await vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, stepPath, { attrs: { status: 'running', startedAt: Date.now() } });
      // Let the advance this update triggers settle while the job is still claimed, so the
      // repair below is the engine's own sweep finding a requeued job.
      await new Promise((r) => setTimeout(r, 1000));
      await vfs.poolSweep(ADMIN_ACCESS, POOL);
      const [requeued] = await vfs.poolJobs(ADMIN_ACCESS, POOL, { state: ['ready', 'claimed'], dedupKey: stepPath });
      assertEquals(requeued.state, 'ready');

      await waitFor(
        async () => (await vfs.get<PipelineStepAttrs>(ADMIN_ACCESS, stepPath)).attrs.status === 'waiting',
        'the step to wait on its requeued job',
        SWEEP_MS * 10,
      );
      assertEquals((await vfs.get<PipelineStepAttrs>(ADMIN_ACCESS, stepPath)).attrs.startedAt, undefined);
      // The same job waits for the next worker, not a new one.
      const [after] = await vfs.poolJobs(ADMIN_ACCESS, POOL, { state: ['ready', 'claimed'], dedupKey: stepPath });
      assertEquals(after.id, requeued.id);
      await waitFor(
        async () => (await vfs.get<PipelineInstanceAttrs>(ADMIN_ACCESS, instancePath)).attrs.status === 'queued',
        'the instance to read queued, nothing executing',
      );
    });

    await t.step('an instance whose steps never arrived is failed', async () => {
      const id = 'stepless-instance';
      await vfs.create<PipelineInstanceAttrs>(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, INSTANCES, id, {
        attrs: {
          pipelineName: 'test-pool-orphan',
          triggerPath: '/work/a.bin',
          status: 'running',
          // Past the grace window, so this is a creation that died between the
          // instance write and the step writes, not one still in progress.
          startedAt: Date.now() - 60 * 60 * 1000,
        },
      });
      const instancePath = join(INSTANCES, id);
      await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, instancePath, 'steps');

      // The `steps` dir is neither an instance nor a step node, so creating it
      // schedules nothing — touch the instance to get an advance.
      await vfs.update<PipelineInstanceAttrs>(ADMIN_ACCESS, instancePath, { attrs: { status: 'running' } });

      await waitFor(
        async () => (await vfs.get<PipelineInstanceAttrs>(ADMIN_ACCESS, instancePath)).attrs.status === 'failed',
        'the stepless instance to be failed',
      );
    });

    await t.step('an instance created moments ago is given time', async () => {
      const id = 'fresh-instance';
      await vfs.create<PipelineInstanceAttrs>(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, INSTANCES, id, {
        attrs: {
          pipelineName: 'test-pool-orphan',
          triggerPath: '/work/a.bin',
          status: 'running',
          startedAt: Date.now(),
        },
      });
      const instancePath = join(INSTANCES, id);
      await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, instancePath, 'steps');
      await vfs.update<PipelineInstanceAttrs>(ADMIN_ACCESS, instancePath, { attrs: { status: 'running' } });
      await new Promise((r) => setTimeout(r, 1000));

      // Still inside the window createInstance's own step writes race in.
      assertEquals((await vfs.get<PipelineInstanceAttrs>(ADMIN_ACCESS, instancePath)).attrs.status, 'running');
    });
  } finally {
    await harness.stop();
  }
});
