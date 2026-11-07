/**
 * What a worker says about itself (`state()`, read by `pool-stat` and the dashboard's flow board):
 * its name, what it offers, what its claimed jobs hold of that, and those jobs by kind.
 */

import { assertEquals } from '@std/assert';
import { PoolWorker } from '../pool-worker.ts';
import type { PoolJob } from '../../../registries/pool/mod.ts';

type Internals = {
  inFlight: Map<number, { job: PoolJob; abort: AbortController }>;
  remaining: Record<string, number>;
};

const worker = (name?: string) =>
  new PoolWorker(
    {} as ConstructorParameters<typeof PoolWorker>[0],
    {} as ConstructorParameters<typeof PoolWorker>[1],
    { poolPath: '/pools/media', name, capacity: { models: 4 }, kinds: ['faces', 'ocr'], concurrency: 4 },
  );

Deno.test('a worker says its name, its slots and what its claimed jobs are', () => {
  const models = worker('models');
  const internals = models as unknown as Internals;
  for (const [id, kind] of [[1, 'faces'], [2, 'faces'], [3, 'ocr']] as const) {
    internals.inFlight.set(id, { job: { id: `job-${id}`, kind } as unknown as PoolJob, abort: new AbortController() });
  }
  internals.remaining.models = 1;

  const state = models.state();
  assertEquals(state.name, 'models');
  assertEquals(state.capacity, { models: 4 });
  assertEquals(state.inUse, { models: 3 });
  assertEquals(state.running, { faces: 2, ocr: 1 });
});

Deno.test('an idle worker started by hand has no name and holds nothing', () => {
  const state = worker().state();
  assertEquals(state.name, undefined);
  assertEquals(state.inUse, { models: 0 });
  assertEquals(state.running, {});
});
