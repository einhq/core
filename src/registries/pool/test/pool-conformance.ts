/**
 * Shared conformance suite for pool registries.
 *
 * Pins the scheduling semantics the pipeline depends on: capability matching,
 * priority with bounded aging, leases and their reclaim, exclusivity classes and
 * idempotent enqueue. Reused by the memory (fast tier) and PostgreSQL (PG tier)
 * implementations — a behavioural difference between them is a bug in one.
 */

import { assertEquals, assertNotEquals, assertRejects } from '@std/assert';
import type { PoolRegistryIf } from '../types.ts';

export type PoolSetup = {
  registry: PoolRegistryIf;
  teardown(): Promise<void>;
};

export type ConformanceOpts = {
  ignore?: boolean;
  sanitize?: boolean;
  /**
   * How long a blocking claim may take to notice a purely time-based change
   * (a lease expiring, `availableAt` passing). The memory registry ticks every
   * 250 ms, PostgreSQL polls every second.
   */
  wakeMs?: number;
};

const dec = new TextDecoder();
const enc = new TextEncoder();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function poolConformanceTests(name: string, setup: () => Promise<PoolSetup>, opts?: ConformanceOpts) {
  const wakeMs = opts?.wakeMs ?? 500;

  Deno.test({
    name,
    ignore: opts?.ignore ?? false,
    sanitizeResources: opts?.sanitize ?? true,
    sanitizeOps: opts?.sanitize ?? true,
  }, async (t) => {
    const { registry, teardown } = await setup();

    try {
      await t.step('touch creates, is idempotent, and stat echoes policy', async () => {
        assertEquals(await registry.touch('p1', { agingSeconds: 60, agingBoost: 5 }), true);
        assertEquals(await registry.touch('p1', { agingSeconds: 60, agingBoost: 5 }), false);
        assertEquals(await registry.touch('p1', { agingSeconds: 30, agingBoost: 5 }), true);
        assertEquals(await registry.touch('p1', { agingSeconds: 60, agingBoost: 5 }), true);
        assertEquals(await registry.exists('p1'), true);

        const stat = await registry.stat('p1');
        assertEquals(stat.size, 0);
        assertEquals(stat.agingSeconds, 60);
        assertEquals(stat.agingBoost, 5);
        assertEquals(stat.counts.total, 0);
      });

      await t.step('stat rejects for an unknown pool', async () => {
        await assertRejects(() => registry.stat('nope'));
      });

      await t.step('add makes a job ready and counted', async () => {
        const job = await registry.add('p1', { kind: 'a', priority: 1, params: { hello: 'world' } });
        assertEquals(job.state, 'ready');
        assertEquals(job.kind, 'a');
        assertEquals(job.priority, 1);
        assertEquals(job.effPriority, 1);
        assertEquals(job.attempts, 0);
        assertEquals(job.params, { hello: 'world' });

        const stat = await registry.stat('p1');
        assertEquals(stat.size, 1);
        assertEquals(stat.counts.ready, 1);
        assertEquals(stat.counts.total, 1);
      });

      await t.step('add rejects a non-finite requirement', async () => {
        await assertRejects(() => registry.add('p1', { kind: 'a', requires: { vramMb: Number.NaN } }));
        await assertRejects(() => registry.add('p1', { kind: 'a', requires: { vramMb: Infinity } }));
      });

      await t.step('dedupKey makes enqueue idempotent', async () => {
        await registry.touch('dedup', {});

        const first = await registry.add('dedup', { kind: 'a', priority: 1, dedupKey: 'step-x' });
        const second = await registry.add('dedup', { kind: 'a', priority: 5, dedupKey: 'step-x' });

        assertEquals(second.id, first.id);
        assertEquals((await registry.counts('dedup')).total, 1);
        // The higher priority wins; a re-add never demotes a waiting job.
        assertEquals(second.priority, 5);

        const third = await registry.add('dedup', { kind: 'a', priority: 2, dedupKey: 'step-x' });
        assertEquals(third.priority, 5);

        // A terminal job frees the key for a genuinely new job.
        await registry.cancel('dedup', { dedupKey: 'step-x' });
        const fourth = await registry.add('dedup', { kind: 'a', dedupKey: 'step-x' });
        assertNotEquals(fourth.id, first.id);
      });

      await t.step('claim takes the highest priority, then the oldest', async () => {
        await registry.touch('order', {});
        const low = await registry.add('order', { kind: 'a', priority: 1 });
        const highOld = await registry.add('order', { kind: 'a', priority: 9 });
        const highNew = await registry.add('order', { kind: 'a', priority: 9 });

        assertEquals((await registry.claim('order', { owner: 'w' }))?.id, highOld.id);
        assertEquals((await registry.claim('order', { owner: 'w' }))?.id, highNew.id);
        assertEquals((await registry.claim('order', { owner: 'w' }))?.id, low.id);
        assertEquals(await registry.claim('order', { owner: 'w' }), null);
      });

      await t.step('claim sets lease, owner and attempts', async () => {
        await registry.touch('lease', { leaseMs: 60_000 });
        await registry.add('lease', { kind: 'a' });

        const job = await registry.claim('lease', { owner: 'worker-1' });
        assertEquals(job?.state, 'claimed');
        assertEquals(job?.leaseOwner, 'worker-1');
        assertEquals(job?.attempts, 1);
        assertEquals((job?.leaseUntil?.getTime() ?? 0) > Date.now(), true);
        assertEquals((await registry.counts('lease')).claimed, 1);
        // `size` is the claimable backlog, so a claimed job no longer counts.
        assertEquals((await registry.stat('lease')).size, 0);
      });

      await t.step('requires must be covered by the offer', async () => {
        await registry.touch('caps', {});
        await registry.add('caps', { kind: 'gpu', requires: { gpu: 1, vramMb: 8000 } });

        assertEquals(await registry.claim('caps', { owner: 'w', offer: { gpu: 1, vramMb: 4000 } }), null);
        assertEquals(await registry.claim('caps', { owner: 'w', offer: { vramMb: 8000 } }), null);

        const job = await registry.claim('caps', { owner: 'w', offer: { gpu: 1, vramMb: 8000 } });
        assertEquals(job?.kind, 'gpu');
      });

      await t.step('a missing offer key counts as zero capacity', async () => {
        await registry.touch('cpuonly', {});
        await registry.add('cpuonly', { kind: 'gpu', requires: { gpu: 1 } });
        const cpu = await registry.add('cpuonly', { kind: 'cpu', requires: { cpu: 1 } });

        // A CPU worker offers no `gpu` at all and must skip past the GPU job.
        const job = await registry.claim('cpuonly', { owner: 'w', offer: { cpu: 4 } });
        assertEquals(job?.id, cpu.id);
      });

      await t.step('an empty offer still claims a job that requires nothing', async () => {
        await registry.touch('free', {});
        await registry.add('free', { kind: 'a' });
        assertNotEquals(await registry.claim('free', { owner: 'w' }), null);
      });

      await t.step('kinds narrows without changing relative order', async () => {
        await registry.touch('kinds', {});
        await registry.add('kinds', { kind: 'x', priority: 9 });
        const y1 = await registry.add('kinds', { kind: 'y', priority: 5 });
        const y2 = await registry.add('kinds', { kind: 'y', priority: 7 });

        assertEquals((await registry.claim('kinds', { owner: 'w', kinds: ['y'] }))?.id, y2.id);
        assertEquals((await registry.claim('kinds', { owner: 'w', kinds: ['y'] }))?.id, y1.id);
        assertEquals(await registry.claim('kinds', { owner: 'w', kinds: ['y'] }), null);
        assertEquals((await registry.claim('kinds', { owner: 'w', kinds: ['x', 'y'] }))?.kind, 'x');
      });

      await t.step('competing claims are disjoint', async () => {
        await registry.touch('race', {});
        for (let i = 0; i < 6; i++) {
          await registry.add('race', { kind: 'a' });
        }

        const claimed = await Promise.all(
          Array.from({ length: 6 }, (_, i) => registry.claim('race', { owner: `w${i}` })),
        );

        const ids = claimed.map((job) => job?.id).filter((id): id is number => id !== undefined);
        assertEquals(ids.length, 6);
        assertEquals(new Set(ids).size, 6);
      });

      await t.step('exclusive is a mutex across the pool', async () => {
        await registry.touch('mutex', {});
        await registry.add('mutex', { kind: 'a', exclusive: 'person-mint' });
        await registry.add('mutex', { kind: 'a', exclusive: 'person-mint' });
        await registry.add('mutex', { kind: 'b' });

        const first = await registry.claim('mutex', { owner: 'w1' });
        assertEquals(first?.exclusive, 'person-mint');

        // The sibling is blocked, but unrelated work still flows.
        assertEquals(await registry.claim('mutex', { owner: 'w2', kinds: ['a'] }), null);
        assertEquals((await registry.claim('mutex', { owner: 'w2', kinds: ['b'] }))?.kind, 'b');

        await registry.complete('mutex', first!.id, 'w1');
        assertEquals((await registry.claim('mutex', { owner: 'w2', kinds: ['a'] }))?.exclusive, 'person-mint');
      });

      await t.step('heartbeat extends the lease and is owner-checked', async () => {
        await registry.touch('hb', { leaseMs: 10_000 });
        await registry.add('hb', { kind: 'a' });
        const job = (await registry.claim('hb', { owner: 'w1' }))!;

        assertEquals(await registry.heartbeat('hb', job.id, 'w1', 60_000), true);
        assertEquals(await registry.heartbeat('hb', job.id, 'someone-else'), false);

        const after = await registry.get('hb', job.id);
        assertEquals((after?.leaseUntil?.getTime() ?? 0) > (job.leaseUntil?.getTime() ?? 0), true);
      });

      await t.step('complete stores the result and is owner-checked', async () => {
        await registry.touch('done', {});
        await registry.add('done', { kind: 'a' });
        const job = (await registry.claim('done', { owner: 'w1' }))!;

        assertEquals(await registry.complete('done', job.id, 'impostor'), null);

        const finished = await registry.complete('done', job.id, 'w1', { ok: true });
        assertEquals(finished?.state, 'done');
        assertEquals(finished?.result, { ok: true });
        assertEquals((await registry.counts('done')).done, 1);
      });

      await t.step('stat splits the same totals per kind', async () => {
        // The dashboard's reason for existing: one pool holds work of very
        // different cost, so a single throughput figure over it tracks the mix
        // rather than the backlog.
        await registry.touch('kinds', {});
        await registry.add('kinds', { kind: 'cheap' });
        await registry.add('kinds', { kind: 'cheap' });
        await registry.add('kinds', { kind: 'expensive' });

        const claimed = (await registry.claim('kinds', { owner: 'w1', kinds: ['expensive'] }))!;
        await registry.complete('kinds', claimed.id, 'w1');

        const { byKind } = await registry.stat('kinds');
        assertEquals(byKind.cheap.ready, 2);
        assertEquals(byKind.cheap.done, 0);
        assertEquals(byKind.expensive.ready, 0);
        assertEquals(byKind.expensive.done, 1);

        // Must reconcile with the un-split counts, or the dashboard shows two
        // numbers for one fact.
        const counts = await registry.counts('kinds');
        const summed = Object.values(byKind).reduce((sum, entry) => sum + entry.total, 0);
        assertEquals(summed, counts.total);

        const stat = await registry.stat('kinds');
        assertEquals(stat.byKind.cheap.ready, 2);
      });

      await t.step('stat says when the oldest ready job of each kind was added', async () => {
        const before = Date.now();
        await registry.touch('waits', {});
        await registry.add('waits', { kind: 'slow', dedupKey: 'first' });
        const added = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 20));
        await registry.add('waits', { kind: 'slow', dedupKey: 'second' });
        await registry.add('waits', { kind: 'gone' });
        const claimed = (await registry.claim('waits', { owner: 'w1', kinds: ['gone'] }))!;
        await registry.complete('waits', claimed.id, 'w1');

        const { oldestReadyAt } = await registry.stat('waits');
        // The first `slow` job, added by `added`, not the second, added 20 ms after it; nothing for a
        // kind with no ready job.
        assertEquals(Object.keys(oldestReadyAt), ['slow']);
        assertEquals(oldestReadyAt.slow >= before - 1000 && oldestReadyAt.slow <= added, true, `${oldestReadyAt.slow} vs ${before}–${added}`);
      });

      await t.step('fail retries with backoff, then goes terminal', async () => {
        await registry.touch('retry', { maxAttempts: 2, backoffMs: 300, backoffMaxMs: 300 });
        await registry.add('retry', { kind: 'a' });

        const first = (await registry.claim('retry', { owner: 'w' }))!;
        const retried = await registry.fail('retry', first.id, 'w', 'boom');
        assertEquals(retried?.state, 'ready');
        assertEquals(retried?.error, 'boom');
        // Backed off, so it is not immediately claimable again.
        assertEquals(await registry.claim('retry', { owner: 'w' }), null);

        await sleep(400);
        const second = (await registry.claim('retry', { owner: 'w' }))!;
        assertEquals(second.attempts, 2);

        const dead = await registry.fail('retry', second.id, 'w', 'boom again');
        assertEquals(dead?.state, 'failed');
        assertEquals((await registry.counts('retry')).failed, 1);
      });

      await t.step('release hands a claimed job back unrun, its attempt given back', async () => {
        await registry.touch('release', { maxAttempts: 1, backoffMs: 60_000, backoffMaxMs: 60_000 });
        await registry.add('release', { kind: 'a' });

        const claimed = (await registry.claim('release', { owner: 'w' }))!;
        assertEquals(claimed.attempts, 1);

        // Only the lease owner may hand it back.
        assertEquals(await registry.release('release', claimed.id, 'other'), null);

        const released = await registry.release('release', claimed.id, 'w');
        assertEquals(released?.state, 'ready');
        assertEquals(released?.attempts, 0);

        // Claimable at once, with no backoff, and its one attempt still to come.
        const again = (await registry.claim('release', { owner: 'w2' }))!;
        assertEquals(again.id, claimed.id);
        assertEquals(again.attempts, 1);

        // A job that is no longer claimed cannot be released.
        await registry.complete('release', again.id, 'w2');
        assertEquals(await registry.release('release', again.id, 'w2'), null);
      });

      await t.step('a job added with attempts already spent carries them, and a re-add leaves them', async () => {
        await registry.touch('carried', { maxAttempts: 3, backoffMs: 10, backoffMaxMs: 20 });
        await registry.add('carried', { kind: 'a', dedupKey: 'step', attempts: 2 });
        // A live job's count is the pool's: re-adding it changes nothing.
        await registry.add('carried', { kind: 'a', dedupKey: 'step', attempts: 0 });

        const claimed = (await registry.claim('carried', { owner: 'w' }))!;
        assertEquals(claimed.attempts, 3);
        assertEquals((await registry.fail('carried', claimed.id, 'w', 'worker died again'))?.state, 'failed');
      });

      await t.step('a terminal fail ends the job whatever attempts are left', async () => {
        await registry.touch('terminal', { maxAttempts: 5, backoffMs: 10, backoffMaxMs: 20 });
        await registry.add('terminal', { kind: 'a' });

        const claimed = (await registry.claim('terminal', { owner: 'w' }))!;
        const dead = await registry.fail('terminal', claimed.id, 'w', 'cannot be decoded', { terminal: true });
        assertEquals(dead?.state, 'failed');
        assertEquals(dead?.error, 'cannot be decoded');
        assertEquals(dead?.attempts, 1);
        await sleep(40);
        assertEquals(await registry.claim('terminal', { owner: 'w' }), null);
      });

      await t.step('a release with a delay holds the job back, its attempt still given back', async () => {
        await registry.touch('release-later', { maxAttempts: 1 });
        await registry.add('release-later', { kind: 'a' });

        const claimed = (await registry.claim('release-later', { owner: 'w' }))!;
        const released = await registry.release('release-later', claimed.id, 'w', 150);
        assertEquals(released?.state, 'ready');
        assertEquals(released?.attempts, 0);

        assertEquals(await registry.claim('release-later', { owner: 'w' }), null);
        await sleep(200);
        const again = (await registry.claim('release-later', { owner: 'w' }))!;
        assertEquals(again.id, claimed.id);
        assertEquals(again.attempts, 1);
      });

      await t.step('a release wakes a blocked claim', async () => {
        await registry.touch('release-wake', {});
        await registry.add('release-wake', { kind: 'a' });
        const held = (await registry.claim('release-wake', { owner: 'w' }))!;

        const controller = new AbortController();
        const waiting = registry.claim('release-wake', { owner: 'w2' }, controller.signal);
        await sleep(50);
        await registry.release('release-wake', held.id, 'w');

        const timer = setTimeout(() => controller.abort(), wakeMs * 4);
        try {
          assertEquals((await waiting)?.id, held.id);
        } finally {
          clearTimeout(timer);
        }
      });

      await t.step('delayMs holds a job back until it is due', async () => {
        await registry.touch('delay', {});
        await registry.add('delay', { kind: 'a', delayMs: 150 });

        assertEquals(await registry.claim('delay', { owner: 'w' }), null);
        await sleep(200);
        assertNotEquals(await registry.claim('delay', { owner: 'w' }), null);
      });

      await t.step('sweep reclaims an expired lease', async () => {
        await registry.touch('expire', { leaseMs: 50, maxAttempts: 5, backoffMs: 1, backoffMaxMs: 1 });
        await registry.add('expire', { kind: 'a' });
        const job = (await registry.claim('expire', { owner: 'dead-worker' }))!;

        await sleep(120);
        const result = await registry.sweep('expire');
        assertEquals(result.reclaimed, 1);

        const after = await registry.get('expire', job.id);
        assertEquals(after?.state, 'ready');
        assertEquals(after?.leaseOwner, undefined);
        // The attempt was still spent: that is how a poison job stops looping.
        assertEquals(after?.attempts, 1);
      });

      await t.step('sweep fails a job whose lease expired with no attempts left', async () => {
        await registry.touch('exhaust', { leaseMs: 50, maxAttempts: 1 });
        await registry.add('exhaust', { kind: 'a' });
        const job = (await registry.claim('exhaust', { owner: 'dead-worker' }))!;

        await sleep(120);
        const result = await registry.sweep('exhaust');
        assertEquals(result.failed, 1);
        assertEquals((await registry.get('exhaust', job.id))?.state, 'failed');
      });

      await t.step('an expired lease still holds its exclusivity class until swept', async () => {
        await registry.touch('excl-expire', { leaseMs: 50, maxAttempts: 5, backoffMs: 1, backoffMaxMs: 1 });
        await registry.add('excl-expire', { kind: 'a', exclusive: 'k' });
        await registry.add('excl-expire', { kind: 'a', exclusive: 'k' });
        await registry.claim('excl-expire', { owner: 'dead' });

        await sleep(120);
        assertEquals(await registry.claim('excl-expire', { owner: 'w2' }), null);

        await registry.sweep('excl-expire');
        assertNotEquals(await registry.claim('excl-expire', { owner: 'w2' }), null);
      });

      await t.step('aging promotes one bucket per sweep and stops at the cap', async () => {
        await registry.touch('aging', { agingSeconds: 1, agingBoost: 10, agingMax: 10 });
        const job = await registry.add('aging', { kind: 'a', priority: 5 });

        // Not yet due: a sweep before the first bucket boundary changes nothing.
        assertEquals((await registry.sweep('aging')).promoted, 0);
        assertEquals((await registry.get('aging', job.id))?.effPriority, 5);

        await sleep(1100);
        assertEquals((await registry.sweep('aging')).promoted, 1);
        assertEquals((await registry.get('aging', job.id))?.effPriority, 15);

        // agingMax is reached, so further sweeps are no-ops however long it waits.
        assertEquals((await registry.sweep('aging')).promoted, 0);
        assertEquals((await registry.get('aging', job.id))?.effPriority, 15);
        assertEquals((await registry.get('aging', job.id))?.priority, 5);
      });

      await t.step('aging is off by default', async () => {
        await registry.touch('noaging', {});
        const job = await registry.add('noaging', { kind: 'a', priority: 5 });
        await sleep(1100);
        assertEquals((await registry.sweep('noaging')).promoted, 0);
        assertEquals((await registry.get('noaging', job.id))?.effPriority, 5);
      });

      await t.step('bounded aging never promotes across a priority lane', async () => {
        // The invariant that preserves strict lane ordering: agingMax (10) is
        // below the gap between lanes (100 - 50), so an aged low-lane job still
        // loses to a freshly added high-lane one.
        await registry.touch('lanes', { agingSeconds: 1, agingBoost: 10, agingMax: 10 });
        const low = await registry.add('lanes', { kind: 'describe', priority: 50 });

        await sleep(1100);
        await registry.sweep('lanes');
        await registry.sweep('lanes');
        assertEquals((await registry.get('lanes', low.id))?.effPriority, 60);

        const high = await registry.add('lanes', { kind: 'faces', priority: 100 });
        assertEquals((await registry.claim('lanes', { owner: 'w' }))?.id, high.id);
        assertEquals((await registry.claim('lanes', { owner: 'w' }))?.id, low.id);
      });

      await t.step('cancel by id, dedup key and dedup key prefix', async () => {
        await registry.touch('cancel', {});
        const byId = await registry.add('cancel', { kind: 'a' });
        await registry.add('cancel', { kind: 'a', dedupKey: 'inst-1/steps/one' });
        await registry.add('cancel', { kind: 'a', dedupKey: 'inst-1/steps/two' });
        await registry.add('cancel', { kind: 'a', dedupKey: 'inst-2/steps/one' });

        assertEquals(await registry.cancel('cancel', { jobId: byId.id }), 1);
        assertEquals((await registry.get('cancel', byId.id))?.state, 'cancelled');

        assertEquals(await registry.cancel('cancel', { dedupKey: 'inst-1/steps/one' }), 1);
        // Prefix cancel is how a removed pipeline instance drops its pending work.
        assertEquals(await registry.cancel('cancel', { dedupKeyPrefix: 'inst-1/' }), 1);
        assertEquals((await registry.counts('cancel')).cancelled, 3);
        assertEquals((await registry.counts('cancel')).ready, 1);

        // Cancelling twice is a no-op, not a double count.
        assertEquals(await registry.cancel('cancel', { dedupKeyPrefix: 'inst-1/' }), 0);
      });

      await t.step('cancel by kind clears what a renamed kind left behind', async () => {
        await registry.touch('cancel-kind', {});
        await registry.add('cancel-kind', { kind: 'gpu-faces', dedupKey: 'a' });
        await registry.add('cancel-kind', { kind: 'gpu-faces', dedupKey: 'b' });
        await registry.add('cancel-kind', { kind: 'faces', dedupKey: 'c' });

        assertEquals(await registry.cancel('cancel-kind', { kind: 'gpu-faces' }), 2);
        assertEquals((await registry.counts('cancel-kind')).ready, 1);
        assertEquals(await registry.cancel('cancel-kind', { kind: 'gpu-faces' }), 0);
      });

      await t.step('cancel reaches a claimed job', async () => {
        await registry.touch('cancel-live', {});
        await registry.add('cancel-live', { kind: 'a', dedupKey: 'k' });
        const job = (await registry.claim('cancel-live', { owner: 'w' }))!;

        assertEquals(await registry.cancel('cancel-live', { dedupKey: 'k' }), 1);
        assertEquals((await registry.get('cancel-live', job.id))?.state, 'cancelled');
        // The worker's late completion must not resurrect it.
        assertEquals(await registry.complete('cancel-live', job.id, 'w'), null);
      });

      await t.step('retry brings a terminal job back with a clean slate', async () => {
        await registry.touch('retryable', { maxAttempts: 1 });
        await registry.add('retryable', { kind: 'a', dedupKey: 'r' });
        const job = (await registry.claim('retryable', { owner: 'w' }))!;
        await registry.fail('retryable', job.id, 'w', 'boom');
        assertEquals((await registry.get('retryable', job.id))?.state, 'failed');

        assertEquals(await registry.retry('retryable', { jobId: job.id }), 1);

        const revived = await registry.get('retryable', job.id);
        assertEquals(revived?.state, 'ready');
        assertEquals(revived?.error, undefined);
        // Attempts reset, or the next sweep would send it straight back.
        assertEquals(revived?.attempts, 0);
        assertNotEquals(await registry.claim('retryable', { owner: 'w' }), null);

        // A ready job is not terminal, so retry leaves it alone.
        assertEquals(await registry.retry('retryable', { dedupKeyPrefix: 'r' }), 0);
      });

      await t.step('purge drops terminal jobs only', async () => {
        await registry.touch('purge', {});
        await registry.add('purge', { kind: 'a' });
        const done = await registry.add('purge', { kind: 'a' });
        const claimed = (await registry.claim('purge', { owner: 'w' }))!;
        await registry.complete('purge', claimed.id, 'w');

        assertEquals(await registry.purge('purge', { olderThanMs: 60_000 }), 0);
        assertEquals(await registry.purge('purge'), 1);
        assertEquals(await registry.get('purge', claimed.id), null);
        assertNotEquals(await registry.get('purge', done.id), null);
        assertEquals((await registry.jobs('purge')).length, 1);

        assertEquals(await registry.purge('purge', { state: 'cancelled' }), 0);
      });

      await t.step('purged jobs still count, so done never falls', async () => {
        // metrics-sampler differences `done` into a throughput; a purge that
        // lowered it would read as a counter reset every cycle.
        await registry.touch('banked', {});
        for (const kind of ['a', 'a', 'b']) {
          await registry.add('banked', { kind });
          const job = (await registry.claim('banked', { owner: 'w' }))!;
          await registry.complete('banked', job.id, 'w');
        }
        await registry.add('banked', { kind: 'a' });

        const before = await registry.stat('banked');
        assertEquals(await registry.purge('banked'), 3);
        assertEquals(await registry.purge('banked'), 0);
        const after = await registry.stat('banked');

        assertEquals(after.counts, before.counts);
        assertEquals(after.byKind, before.byKind);
        assertEquals(after.byKind.a.done, 2);
        assertEquals(after.byKind.b.done, 1);
        assertEquals(after.counts.ready, 1);
      });

      await t.step('jobs filters by state and kind, and pages by id', async () => {
        await registry.touch('listing', {});
        const a = await registry.add('listing', { kind: 'x' });
        await registry.add('listing', { kind: 'y' });
        await registry.add('listing', { kind: 'y' });

        assertEquals((await registry.jobs('listing')).length, 3);
        assertEquals((await registry.jobs('listing', { kind: 'y' })).length, 2);
        assertEquals((await registry.jobs('listing', { state: 'ready' })).length, 3);
        assertEquals((await registry.jobs('listing', { state: ['done', 'failed'] })).length, 0);
        assertEquals((await registry.jobs('listing', { limit: 2 })).length, 2);

        const page = await registry.jobs('listing', { afterId: a.id });
        assertEquals(page.length, 2);
        assertEquals(page.every((job) => job.id > a.id), true);
      });

      await t.step('a claim with no signal returns null instead of blocking', async () => {
        // The engine's fair-share trigger admission probes one kind at a time and
        // relies on this: with a signal these would park on the first empty kind
        // forever. Pinned here because it is a contract, not an implementation
        // detail — `null` from a signal-less claim means "nothing right now",
        // while `null` from a blocking claim means "aborted".
        await registry.touch('nonblocking', {});
        assertEquals(await registry.claim('nonblocking', { owner: 'w' }), null);

        await registry.add('nonblocking', { kind: 'present' });

        // A kind that has no work must not consume the one that does.
        assertEquals(await registry.claim('nonblocking', { owner: 'w', kinds: ['absent'] }), null);

        const job = await registry.claim('nonblocking', { owner: 'w', kinds: ['present'] });
        assertEquals(job?.kind, 'present');
        assertEquals(await registry.claim('nonblocking', { owner: 'w' }), null);
      });

      await t.step('blocking claim resolves when matching work arrives', async () => {
        await registry.touch('block', {});
        const controller = new AbortController();
        const pending = registry.claim('block', { owner: 'w' }, controller.signal);

        await sleep(50);
        await registry.add('block', { kind: 'a' });

        const job = await pending;
        assertEquals(job?.kind, 'a');
        controller.abort();
      });

      await t.step('blocking claim ignores work the offer cannot satisfy', async () => {
        await registry.touch('block-caps', {});
        const controller = new AbortController();
        const pending = registry.claim('block-caps', { owner: 'w', offer: { cpu: 1 } }, controller.signal);

        await registry.add('block-caps', { kind: 'gpu', requires: { gpu: 1 } });
        await sleep(wakeMs);

        // Still parked: a notification is not an invitation, the offer must match.
        await registry.add('block-caps', { kind: 'cpu', requires: { cpu: 1 } });
        assertEquals((await pending)?.kind, 'cpu');
        controller.abort();
      });

      await t.step('blocking claim wakes on a lease expiry with no insert', async () => {
        // Nothing is written when a lease lapses, so a notify-only design would
        // park here forever. The periodic poll is what makes this terminate.
        // sweepIntervalMs is what bounds the reclaim, so a test that waits for
        // one has to ask for a cadence it can actually wait out.
        await registry.touch('block-expire', { leaseMs: 100, maxAttempts: 5, backoffMs: 1, backoffMaxMs: 1, sweepIntervalMs: 50 });
        await registry.add('block-expire', { kind: 'a' });
        await registry.claim('block-expire', { owner: 'dead' });

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), wakeMs * 6);

        try {
          const job = await registry.claim('block-expire', { owner: 'w2' }, controller.signal);
          assertEquals(job?.leaseOwner, 'w2');
          assertEquals(job?.attempts, 2);
        } finally {
          clearTimeout(timer);
          controller.abort();
        }
      });

      await t.step('blocking claim returns null only on abort', async () => {
        await registry.touch('block-abort', {});
        const controller = new AbortController();
        const pending = registry.claim('block-abort', { owner: 'w' }, controller.signal);

        await sleep(50);
        controller.abort();
        assertEquals(await pending, null);
      });

      await t.step('handle read is a non-destructive snapshot', async () => {
        await registry.touch('handle', {});
        const handle = await registry.open('handle', {}, 'r+');

        try {
          await handle.write(enc.encode(JSON.stringify({ kind: 'a', priority: 1 }) + '\n' + JSON.stringify({ kind: 'b', priority: 2 }) + '\n'));
          assertEquals((await registry.counts('handle')).ready, 2);
          assertEquals(await handle.size(), 2);

          const first = JSON.parse(dec.decode(await handle.read(1)).trim());
          const second = JSON.parse(dec.decode(await handle.read(1)).trim());
          assertEquals(first.kind, 'a');
          assertEquals(second.kind, 'b');
          assertEquals((await handle.read(1)).length, 0);

          // Reading did not consume anything — unlike a queue.
          assertEquals((await registry.counts('handle')).ready, 2);
        } finally {
          await handle.close();
        }

        // A fresh handle sees the same jobs again.
        const again = await registry.open('handle', {}, 'r');
        try {
          assertEquals(JSON.parse(dec.decode(await again.read(1)).trim()).kind, 'a');
        } finally {
          await again.close();
        }
      });

      await t.step("open with 'w' truncates the pool", async () => {
        await registry.touch('trunc', {});
        await registry.add('trunc', { kind: 'a' });
        assertEquals((await registry.counts('trunc')).total, 1);

        const handle = await registry.open('trunc', {}, 'w');
        await handle.close();
        assertEquals((await registry.counts('trunc')).total, 0);
      });

      await t.step('open for read rejects an unknown pool', async () => {
        await assertRejects(() => registry.open('missing', {}, 'r'));
      });

      await t.step('delete removes the pool and its jobs', async () => {
        await registry.touch('gone', {});
        await registry.add('gone', { kind: 'a' });

        assertEquals(await registry.delete('gone'), true);
        assertEquals(await registry.delete('gone'), false);
        assertEquals(await registry.exists('gone'), false);
        await assertRejects(() => registry.stat('gone'));
      });

      await t.step('list and count cover every pool', async () => {
        const ids: string[] = [];
        for await (const id of await registry.list()) {
          ids.push(id);
        }

        assertEquals(ids.includes('p1'), true);
        assertEquals(ids.includes('gone'), false);
        assertEquals(await registry.count(), ids.length);
      });
    } finally {
      await teardown();
    }
  });
}
