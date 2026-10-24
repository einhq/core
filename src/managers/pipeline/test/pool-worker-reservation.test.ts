/**
 * A soft capacity reservation prevents continuous high-priority entry work
 * from occupying the entire worker while remaining work-conserving.
 */

import { assertEquals } from '@std/assert';
import { PoolWorker } from '../pool-worker.ts';
import type { PoolClaimRequest, PoolJob } from '../../../registries/pool/mod.ts';

type Internals = {
  abort: AbortController;
  remaining: Record<string, number>;
  inFlight: Map<number, { job: PoolJob; abort: AbortController }>;
  reserveCursor: number;
  accumulatingFor: string | undefined;
  capacityExhausted(): boolean;
  claimWithReservation(): Promise<PoolJob | null | undefined>;
  /** Test-side handles on the fake pool. */
  jobs: PoolJob[];
  refuse: Set<string>;
};

const priorities: Record<string, number> = {
  ingest: 100,
  derive: 60,
  fingerprint: 30,
  transcode: 10,
};

function makeWorker(input: { kind: string; requires: Record<string, number> }[]) {
  const jobs = input.map((job, index) => ({
    id: index + 1,
    kind: job.kind,
    priority: priorities[job.kind],
    requires: job.requires,
    availableAt: new Date(0),
  })) as PoolJob[];
  const claims: { kinds?: string[]; offer?: Record<string, number> }[] = [];
  // Kinds the fake pool declines for a reason other than capacity.
  const refuse = new Set<string>();
  const vfs = {
    poolClaim(_access: unknown, _pool: string, req: PoolClaimRequest): Promise<PoolJob | null> {
      claims.push({ kinds: req.kinds, offer: { ...req.offer } });
      const eligible = jobs
        .filter((job) => !req.kinds || req.kinds.includes(job.kind))
        .filter((job) => !refuse.has(job.kind))
        .filter((job) => Object.entries(job.requires).every(([key, value]) => value <= (req.offer?.[key] ?? 0)))
        .sort((a, b) => b.priority - a.priority);
      const selected = eligible[0];
      if (!selected) return Promise.resolve(null);
      jobs.splice(jobs.indexOf(selected), 1);
      return Promise.resolve(selected);
    },
    poolJobs(_access: unknown, _pool: string, filter: { kind?: string }): Promise<PoolJob[]> {
      return Promise.resolve(jobs.filter((job) => !filter.kind || job.kind === filter.kind));
    },
  };
  const worker = new PoolWorker(
    vfs as unknown as ConstructorParameters<typeof PoolWorker>[0],
    {} as ConstructorParameters<typeof PoolWorker>[1],
    {
      poolPath: '/var/pools/media',
      capacity: { cpu: 5 },
      kinds: ['ingest', 'derive', 'fingerprint', 'transcode'],
      reserveKinds: ['derive', 'fingerprint', 'transcode'],
      reserveCapacity: { cpu: 2 },
    },
  ) as unknown as Internals;
  worker.abort = new AbortController();
  worker.jobs = jobs;
  worker.refuse = refuse;
  return { worker, claims };
}

Deno.test('default worker keeps the original strict-priority claim', async () => {
  const jobs = [
    { id: 1, kind: 'ingest', priority: 100, requires: { cpu: 1 } },
    { id: 2, kind: 'derive', priority: 60, requires: { cpu: 1 } },
  ] as unknown as PoolJob[];
  const claims: PoolClaimRequest[] = [];
  const vfs = {
    poolClaim(_access: unknown, _pool: string, req: PoolClaimRequest): Promise<PoolJob | null> {
      claims.push(req);
      return Promise.resolve(jobs[0]);
    },
    poolJobs(): Promise<PoolJob[]> {
      return Promise.resolve([]);
    },
  };
  const worker = new PoolWorker(
    vfs as unknown as ConstructorParameters<typeof PoolWorker>[0],
    {} as ConstructorParameters<typeof PoolWorker>[1],
    { poolPath: '/var/pools/media', capacity: { cpu: 5 }, kinds: ['ingest', 'derive'] },
  ) as unknown as Internals;
  worker.abort = new AbortController();

  assertEquals((await worker.claimWithReservation())?.kind, 'ingest');
  assertEquals(claims.length, 1);
  assertEquals(claims[0].kinds, ['ingest', 'derive']);
});

Deno.test('normal priority fills capacity above the reserved boundary', async () => {
  const { worker, claims } = makeWorker([
    { kind: 'ingest', requires: { cpu: 1 } },
    { kind: 'derive', requires: { cpu: 1 } },
  ]);
  worker.remaining = { cpu: 3 };

  assertEquals((await worker.claimWithReservation())?.kind, 'ingest');
  assertEquals(claims.map((claim) => claim.kinds), [['ingest', 'derive', 'fingerprint', 'transcode']]);
});

Deno.test('downstream work gets the next compatible reserved slot', async () => {
  const { worker, claims } = makeWorker([
    { kind: 'ingest', requires: { cpu: 1 } },
    { kind: 'derive', requires: { cpu: 1 } },
  ]);
  worker.remaining = { cpu: 1 };

  assertEquals((await worker.claimWithReservation())?.kind, 'derive');
  assertEquals(claims.map((claim) => claim.kinds), [['derive']]);
});

Deno.test('unused reserved capacity remains work-conserving', async () => {
  const { worker, claims } = makeWorker([{ kind: 'ingest', requires: { cpu: 1 } }]);
  worker.remaining = { cpu: 2 };

  assertEquals((await worker.claimWithReservation())?.kind, 'ingest');
  assertEquals(claims.map((claim) => claim.kinds), [
    ['derive'],
    ['fingerprint'],
    ['transcode'],
    ['ingest', 'derive', 'fingerprint', 'transcode'],
  ]);
});

Deno.test('reservation respects weighted capacity requirements', async () => {
  const { worker, claims } = makeWorker([
    { kind: 'ingest', requires: { cpu: 1 } },
    { kind: 'transcode', requires: { cpu: 2 } },
  ]);
  worker.remaining = { cpu: 2 };

  assertEquals((await worker.claimWithReservation())?.kind, 'transcode');
  assertEquals(claims[2].offer, { cpu: 2 });
});

Deno.test('weighted downstream work accumulates reserved capacity', async () => {
  const { worker, claims } = makeWorker([
    { kind: 'ingest', requires: { cpu: 1 } },
    { kind: 'transcode', requires: { cpu: 2 } },
  ]);
  worker.remaining = { cpu: 1 };

  // One free slot cannot run the transcode. Returning undefined tells the
  // claim loop to wait for another in-flight completion instead of borrowing
  // the partial reservation for ingest. The transcode is probed twice: once
  // with the reserved share, once with everything free.
  assertEquals(await worker.claimWithReservation(), undefined);
  assertEquals(claims.map((claim) => claim.kinds), [['derive'], ['fingerprint'], ['transcode'], ['transcode']]);

  worker.remaining = { cpu: 2 };
  assertEquals((await worker.claimWithReservation())?.kind, 'transcode');
});

Deno.test('reserved kinds rotate under a continuous mixed backlog', async () => {
  const { worker } = makeWorker([
    { kind: 'derive', requires: { cpu: 1 } },
    { kind: 'derive', requires: { cpu: 1 } },
    { kind: 'fingerprint', requires: { cpu: 1 } },
    { kind: 'fingerprint', requires: { cpu: 1 } },
    { kind: 'transcode', requires: { cpu: 2 } },
    { kind: 'transcode', requires: { cpu: 2 } },
  ]);

  const selected: string[] = [];
  for (let index = 0; index < 3; index++) {
    worker.remaining = { cpu: 2 };
    selected.push((await worker.claimWithReservation())!.kind);
  }

  assertEquals(selected, ['derive', 'fingerprint', 'transcode']);
});

Deno.test('borrowed downstream work counts against the soft reservation', async () => {
  const { worker } = makeWorker([
    { kind: 'ingest', requires: { cpu: 1 } },
    { kind: 'transcode', requires: { cpu: 2 } },
  ]);
  worker.inFlight.set(99, {
    job: { kind: 'transcode', requires: { cpu: 2 } } as unknown as PoolJob,
    abort: new AbortController(),
  });
  worker.remaining = { cpu: 1 };

  // The downstream share is already occupied. Do not hold this free slot for
  // another weighted downstream job; ordinary priority work may borrow it.
  assertEquals((await worker.claimWithReservation())?.kind, 'ingest');
});

Deno.test('an exhausted offer waits for capacity before re-evaluating policy', () => {
  const { worker } = makeWorker([]);
  worker.remaining = { cpu: 0 };
  assertEquals(worker.capacityExhausted(), true);
  worker.remaining = { cpu: 1 };
  assertEquals(worker.capacityExhausted(), false);
});

Deno.test('a weighted job accumulates capacity while one-slot downstream work is in flight', async () => {
  // The production shape: one derive already holds a reserved slot, so the reserved
  // share is a single slot and the transcode can never fit it. Its turn must
  // hold the freed slot anyway rather than move on to the next one-slot kind.
  const { worker, claims } = makeWorker([
    { kind: 'ingest', requires: { cpu: 1 } },
    { kind: 'fingerprint', requires: { cpu: 1 } },
    { kind: 'transcode', requires: { cpu: 2 } },
  ]);
  worker.inFlight.set(99, {
    job: { kind: 'derive', requires: { cpu: 1 } } as unknown as PoolJob,
    abort: new AbortController(),
  });
  worker.reserveCursor = 2;
  worker.remaining = { cpu: 1 };

  assertEquals(await worker.claimWithReservation(), undefined);
  assertEquals(worker.accumulatingFor, 'transcode');
  assertEquals(claims.map((claim) => claim.kinds), [['transcode'], ['transcode']]);

  worker.remaining = { cpu: 2 };
  assertEquals((await worker.claimWithReservation())?.kind, 'transcode');
  assertEquals(worker.accumulatingFor, undefined);
  assertEquals(claims.at(-1)?.offer, { cpu: 2 });
});

Deno.test('a hold outlives the reserved boundary until the weighted job fits', async () => {
  const { worker } = makeWorker([
    { kind: 'ingest', requires: { cpu: 1 } },
    { kind: 'transcode', requires: { cpu: 3 } },
  ]);
  worker.reserveCursor = 2;
  worker.remaining = { cpu: 1 };

  assertEquals(await worker.claimWithReservation(), undefined);
  worker.remaining = { cpu: 2 };
  assertEquals(await worker.claimWithReservation(), undefined);
  // Above the boundary the normal path would give ingest the slots; the
  // held kind still comes first.
  worker.remaining = { cpu: 3 };
  assertEquals((await worker.claimWithReservation())?.kind, 'transcode');
});

Deno.test('a weighted job at its turn may complete its requirement from the unreserved share', async () => {
  const { worker } = makeWorker([
    { kind: 'ingest', requires: { cpu: 1 } },
    { kind: 'transcode', requires: { cpu: 2 } },
  ]);
  worker.inFlight.set(99, {
    job: { kind: 'derive', requires: { cpu: 1 } } as unknown as PoolJob,
    abort: new AbortController(),
  });
  worker.reserveCursor = 2;
  worker.remaining = { cpu: 2 };

  assertEquals((await worker.claimWithReservation())?.kind, 'transcode');
  assertEquals(worker.accumulatingFor, undefined);
});

Deno.test('a hold is released when the weighted job is no longer waiting', async () => {
  const { worker } = makeWorker([
    { kind: 'ingest', requires: { cpu: 1 } },
    { kind: 'transcode', requires: { cpu: 2 } },
  ]);
  worker.reserveCursor = 2;
  worker.remaining = { cpu: 1 };

  assertEquals(await worker.claimWithReservation(), undefined);
  assertEquals(worker.accumulatingFor, 'transcode');

  // Cancelled, or claimed by another worker.
  worker.jobs.splice(worker.jobs.findIndex((job) => job.kind === 'transcode'), 1);
  assertEquals((await worker.claimWithReservation())?.kind, 'ingest');
  assertEquals(worker.accumulatingFor, undefined);
});

Deno.test('a job refused for a reason capacity cannot fix is not held for', async () => {
  // Fits the offer already, so the pool declined it for another reason
  // (say an exclusive class). Holding would stall admission for nothing.
  const { worker, claims } = makeWorker([
    { kind: 'ingest', requires: { cpu: 1 } },
    { kind: 'fingerprint', requires: { cpu: 1 } },
  ]);
  worker.refuse.add('fingerprint');
  worker.reserveCursor = 1;
  worker.remaining = { cpu: 1 };

  assertEquals((await worker.claimWithReservation())?.kind, 'ingest');
  assertEquals(worker.accumulatingFor, undefined);
  assertEquals(claims.map((claim) => claim.kinds), [
    ['fingerprint'],
    ['transcode'],
    ['derive'],
    ['ingest', 'derive', 'fingerprint', 'transcode'],
  ]);
});
