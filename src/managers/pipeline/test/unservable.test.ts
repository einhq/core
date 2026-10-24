/**
 * A pool kind nobody offers is silent from the pool's side: the jobs are `ready` and stay
 * `ready`, with no attempt, no lease and no error to hang an alarm on. The tracker is the join
 * the pool cannot do — its per-kind backlog against the live workers' offers — plus a grace
 * period, since a worker that has not started yet is not a fault.
 *
 * The first test is a kind renamed under queued jobs: the old kind keeps growing and no worker
 * offers it.
 */

import { assertEquals } from '@std/assert';
import type { PoolWorkerState } from '../pool-worker.ts';
import { UnservableTracker } from '../unservable.ts';

const GRACE = 1000;
const POOLS = '/var/pools';

const worker = (pool: string, kinds: string[], currentKind?: string): PoolWorkerState => ({
  pool: `${POOLS}/${pool}`,
  owner: `test:${pool}:${kinds.join('+')}`,
  kinds,
  currentKind,
  kindQuantumMs: 0,
  concurrency: 1,
  reserveKinds: [],
  reserveCapacity: {},
  resting: {},
});

const media = (ready: Record<string, number>) => ({
  media: { byKind: Object.fromEntries(Object.entries(ready).map(([kind, n]) => [kind, { ready: n }])) },
});

Deno.test('a kind with ready jobs that no worker offers is unservable once the grace has run out', () => {
  const tracker = new UnservableTracker(GRACE);
  const gpu = worker('media', ['gpu-describe-image', 'gpu-faces'], 'gpu-faces');
  const pools = media({ 'gpu-describe': 2793, 'gpu-faces': 71 });

  assertEquals(tracker.observe(POOLS, pools, [gpu], 1000), [], 'first sight is inside the grace');
  assertEquals(tracker.observe(POOLS, pools, [gpu], 1000 + GRACE), [
    { pool: 'media', kind: 'gpu-describe', ready: 2793, since: 1000 },
  ]);
});

Deno.test('a kind whose worker is busy on another kind is waiting, not unservable', () => {
  const tracker = new UnservableTracker(GRACE);
  const gpu = worker('media', ['gpu-describe-image', 'gpu-faces'], 'gpu-faces');
  const pools = media({ 'gpu-describe-image': 91, 'gpu-faces': 71 });

  tracker.observe(POOLS, pools, [gpu], 0);
  assertEquals(tracker.observe(POOLS, pools, [gpu], 10 * GRACE), []);
});

Deno.test('the grace covers a worker that starts late', () => {
  const tracker = new UnservableTracker(GRACE);
  const pools = media({ 'gpu-faces': 71 });

  assertEquals(tracker.observe(POOLS, pools, [], 0), [], 'nothing offers it yet, but the process just booted');
  assertEquals(tracker.observe(POOLS, pools, [worker('media', ['gpu-faces'])], GRACE - 1), []);
  assertEquals(tracker.observe(POOLS, pools, [worker('media', ['gpu-faces'])], 10 * GRACE), [], 'and once offered it never fires');
});

Deno.test('the alarm clears when the kind is offered again or its jobs are gone', () => {
  const tracker = new UnservableTracker(GRACE);
  const pools = media({ 'gpu-describe': 10 });

  tracker.observe(POOLS, pools, [], 0);
  assertEquals(tracker.observe(POOLS, pools, [], GRACE).length, 1);

  assertEquals(tracker.observe(POOLS, pools, [worker('media', ['gpu-describe'])], 2 * GRACE), [], 'a worker for it started');

  tracker.observe(POOLS, pools, [], 3 * GRACE);
  assertEquals(tracker.observe(POOLS, pools, [], 4 * GRACE).length, 1, 'the grace runs again from the second sighting');
  assertEquals(tracker.observe(POOLS, media({ 'gpu-describe': 0 }), [], 5 * GRACE), [], 'cancelled');
  assertEquals(tracker.observe(POOLS, {}, [], 6 * GRACE), [], 'pool gone');
});

Deno.test('a worker with no kinds offers everything in its pool, and only in its pool', () => {
  const tracker = new UnservableTracker(GRACE);
  const pools = {
    ...media({ 'anything': 5 }),
    other: { byKind: { anything: { ready: 5 } } },
  };
  const any = worker('media', []);

  tracker.observe(POOLS, pools, [any], 0);
  assertEquals(tracker.observe(POOLS, pools, [any], GRACE), [
    { pool: 'other', kind: 'anything', ready: 5, since: 0 },
  ]);
});

Deno.test('the intake pool is never unservable — the engine claims it, not a worker', () => {
  const tracker = new UnservableTracker(GRACE);
  const pools = { triggers: { byKind: { 'media-ingest': { ready: 24_000 } } } };

  tracker.observe(POOLS, pools, [], 0);
  assertEquals(tracker.observe(POOLS, pools, [], GRACE), []);
});

Deno.test('the reported count follows the backlog while `since` does not', () => {
  const tracker = new UnservableTracker(GRACE);

  tracker.observe(POOLS, media({ 'gpu-describe': 100 }), [], 0);
  assertEquals(tracker.observe(POOLS, media({ 'gpu-describe': 572 }), [], GRACE), [
    { pool: 'media', kind: 'gpu-describe', ready: 572, since: 0 },
  ]);
  assertEquals(tracker.unservable(2 * GRACE), [{ pool: 'media', kind: 'gpu-describe', ready: 572, since: 0 }]);
});
