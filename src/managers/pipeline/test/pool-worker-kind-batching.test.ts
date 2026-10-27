/**
 * Kind batching: which kind the GPU worker claims next, and why.
 *
 * The decision table only, with the pool stubbed. The wiring — that a real worker claims real
 * jobs — is covered by `pool-worker.test.ts` against the full-boot harness; what has no other
 * coverage is the rotation, and rotation is the part that is load-bearing:
 *
 *   - A rotation does not cross an in-flight batch boundary, so two kinds' commands do not run
 *     together.
 *   - Priority alone starves the lower kind: when a priority-100 kind arrives continuously,
 *     "always take the highest priority" never runs the priority-50 one. The quantum is what
 *     breaks that, and a failure here is silent.
 */

import { assertEquals } from '@std/assert';
import { PoolWorker } from '../pool-worker.ts';
import type { PoolJob } from '../../../registries/pool/mod.ts';

/** Only the members the batching path touches. */
type ClaimStub = { kinds?: string[] };
type Internals = {
  abort: AbortController;
  currentKind: string | undefined;
  kindSince: number;
  inFlight: Map<number, { job: PoolJob; abort: AbortController }>;
  boundarySince: number | undefined;
  paused: Map<string, { until: number; ms: number }>;
  claimBatched(): Promise<PoolJob | null | undefined>;
};

/**
 * A worker whose pool holds `available` jobs per kind, and which records the order kinds were
 * asked in — the assertions are about *which kind is claimed*, so the queue depth per kind is
 * all the pool needs to model.
 */
function makeWorker(available: Record<string, number>, quantumMs = 1000) {
  const asked: string[] = [];
  let seq = 0;

  const vfs = {
    poolClaim(_access: unknown, _pool: string, req: ClaimStub): Promise<PoolJob | null> {
      // No kinds means the blocking all-kinds park; take from whatever still has work.
      const kinds = req.kinds ?? Object.keys(available);
      if (req.kinds?.length === 1) asked.push(req.kinds[0]);
      for (const kind of kinds) {
        if ((available[kind] ?? 0) > 0) {
          available[kind]--;
          return Promise.resolve({ id: `job-${++seq}`, kind } as unknown as PoolJob);
        }
      }
      return Promise.resolve(null);
    },
  };

  const worker = new PoolWorker(
    vfs as unknown as ConstructorParameters<typeof PoolWorker>[0],
    {} as ConstructorParameters<typeof PoolWorker>[1],
    { poolPath: '/pools/media', kinds: ['gpu-faces', 'gpu-describe'], kindQuantumMs: quantumMs },
  );
  const internals = worker as unknown as Internals;
  internals.abort = new AbortController();
  return { worker: internals, asked, available };
}

Deno.test('stays on one kind while it has work and the quantum holds', async () => {
  const { worker } = makeWorker({ 'gpu-faces': 5, 'gpu-describe': 5 });

  const kinds: string[] = [];
  for (let i = 0; i < 4; i++) kinds.push((await worker.claimBatched())!.kind);

  // Both kinds have work throughout, so priority would have interleaved them. Batching must not.
  assertEquals(kinds, ['gpu-faces', 'gpu-faces', 'gpu-faces', 'gpu-faces']);
});

Deno.test('rotates when the quantum expires and the other kind has work', async () => {
  const { worker } = makeWorker({ 'gpu-faces': 50, 'gpu-describe': 5 });

  assertEquals((await worker.claimBatched())!.kind, 'gpu-faces');
  // Backdate the batch past its quantum rather than sleeping.
  worker.kindSince = Date.now() - 5000;

  // gpu-faces still has 49 jobs queued. Without the quantum this would never leave it, which is
  // the starvation the whole mechanism exists to prevent.
  assertEquals((await worker.claimBatched())!.kind, 'gpu-describe');
});

Deno.test('rotates when the current kind drains, without waiting for the quantum', async () => {
  const { worker } = makeWorker({ 'gpu-faces': 1, 'gpu-describe': 3 });

  assertEquals((await worker.claimBatched())!.kind, 'gpu-faces');
  assertEquals((await worker.claimBatched())!.kind, 'gpu-describe');
});

Deno.test('waits for every in-flight command of the current kind before rotating', async () => {
  const { worker, asked } = makeWorker({ 'gpu-faces': 1, 'gpu-describe': 3 });

  const face = (await worker.claimBatched())!;
  worker.inFlight.set(1, { job: face, abort: new AbortController() });

  // The ready face queue is empty, but its command is still finalising. The
  // worker must not even probe the next model family across that boundary.
  assertEquals(await worker.claimBatched(), undefined);
  assertEquals(asked, ['gpu-faces', 'gpu-faces']);

  worker.inFlight.clear();
  assertEquals((await worker.claimBatched())!.kind, 'gpu-describe');
});

Deno.test('a long command of the old kind holds the boundary for five minutes, not for as long as it runs', async () => {
  const { worker } = makeWorker({ 'gpu-faces': 1, 'gpu-describe': 3 });

  const face = (await worker.claimBatched())!;
  worker.inFlight.set(1, { job: face, abort: new AbortController() });
  assertEquals(await worker.claimBatched(), undefined);

  // The face command is still running five minutes on (a diarize over a long video, in the
  // case that held fry's models worker for an hour). The free slots go to the next kind.
  worker.boundarySince = Date.now() - 5 * 60_000;
  assertEquals((await worker.claimBatched())!.kind, 'gpu-describe');
});

Deno.test('a resting kind is not claimed, and its in-flight command holds nothing', async () => {
  const { worker, asked } = makeWorker({ 'gpu-faces': 5, 'gpu-describe': 3 });

  const face = (await worker.claimBatched())!;
  worker.inFlight.set(1, { job: face, abort: new AbortController() });
  // Its last step found EMS unable to do faces yet.
  worker.paused.set('gpu-faces', { until: Date.now() + 30_000, ms: 30_000 });

  assertEquals((await worker.claimBatched())!.kind, 'gpu-describe');
  assertEquals(asked.filter((kind) => kind === 'gpu-faces').length, 1);
});

Deno.test('an expired quantum with nothing else waiting keeps the kind and restarts the clock', async () => {
  const { worker } = makeWorker({ 'gpu-faces': 5, 'gpu-describe': 0 });

  assertEquals((await worker.claimBatched())!.kind, 'gpu-faces');
  const expiredAt = Date.now() - 5000;
  worker.kindSince = expiredAt;

  assertEquals((await worker.claimBatched())!.kind, 'gpu-faces');
  // The clock restarted, so the next claim does not re-probe the empty kind on every job.
  assertEquals(worker.kindSince > expiredAt, true);
});

Deno.test('an idle pool parks on all kinds and the first arrival sets the batch', async () => {
  const { worker } = makeWorker({ 'gpu-faces': 0, 'gpu-describe': 2 });

  const job = await worker.claimBatched();
  assertEquals(job!.kind, 'gpu-describe');
  assertEquals(worker.currentKind, 'gpu-describe');
});

/** A worker over three kinds, two of which share their turns. */
function makeGroupedWorker(available: Record<string, number>) {
  let seq = 0;
  const vfs = {
    poolClaim(_access: unknown, _pool: string, req: ClaimStub): Promise<PoolJob | null> {
      const kinds = req.kinds ?? Object.keys(available);
      for (const kind of kinds) {
        if ((available[kind] ?? 0) > 0) {
          available[kind]--;
          return Promise.resolve({ id: `job-${++seq}`, kind } as unknown as PoolJob);
        }
      }
      return Promise.resolve(null);
    },
  };
  const worker = new PoolWorker(
    vfs as unknown as ConstructorParameters<typeof PoolWorker>[0],
    {} as ConstructorParameters<typeof PoolWorker>[1],
    { poolPath: '/pools/media', kinds: ['faces', 'embed-picture', 'transcribe'], kindGroups: [['faces', 'embed-picture']], kindQuantumMs: 1000 },
  );
  const internals = worker as unknown as Internals;
  internals.abort = new AbortController();
  return internals;
}

Deno.test('the kinds of a group take claims in turn within one turn of the rotation', async () => {
  const worker = makeGroupedWorker({ faces: 5, 'embed-picture': 5, transcribe: 5 });
  const kinds: string[] = [];
  for (let i = 0; i < 4; i++) kinds.push((await worker.claimBatched())!.kind);
  assertEquals(kinds, ['faces', 'embed-picture', 'faces', 'embed-picture']);
  assertEquals(worker.currentKind, 'faces+embed-picture');
});

Deno.test('a group is one turn: the rotation passes from it to the next kind, and back', async () => {
  const worker = makeGroupedWorker({ faces: 50, 'embed-picture': 50, transcribe: 5 });
  await worker.claimBatched();
  worker.kindSince = Date.now() - 5000;
  worker.inFlight.clear();
  assertEquals((await worker.claimBatched())!.kind, 'transcribe');
  assertEquals(worker.currentKind, 'transcribe');
  worker.kindSince = Date.now() - 5000;
  worker.inFlight.clear();
  assertEquals((await worker.claimBatched())!.kind === 'transcribe', false);
  assertEquals(worker.currentKind, 'faces+embed-picture');
});

Deno.test('a command of the group in flight holds the boundary for the whole group', async () => {
  const worker = makeGroupedWorker({ faces: 50, 'embed-picture': 50, transcribe: 5 });
  const job = (await worker.claimBatched())!;
  worker.inFlight.set(1, { job: { ...job, kind: 'embed-picture' } as PoolJob, abort: new AbortController() });
  worker.kindSince = Date.now() - 5000;
  assertEquals(await worker.claimBatched(), undefined);
});
