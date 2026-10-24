/**
 * Shared conformance suite for queue registries.
 *
 * Pins the QueueHandle protocol the pipeline engine depends on: one unacked
 * entry per handle, ack/nack via write, nack-on-close, routed fanout and
 * competing consumers — and what the router relay retains: nothing for a key
 * no queue is bound to, and a message only until its last delivery is acked.
 * Reused by the memory (fast tier) and PostgreSQL (PG tier) implementations.
 */

import { assertEquals, assertRejects } from '@std/assert';
import type { RouterManagerIf } from '../../../managers/router/mod.ts';
import type { QueueRegistryIf } from '../types.ts';
import { waitFor } from '../../test/relay-wait.ts';

/** How many messages and deliveries the backend holds, across all queues. */
export type Retained = { messages: number; deliveries: number };

export type QueueSetup = {
  registry: QueueRegistryIf;
  router: RouterManagerIf;
  /**
   * Counts what the backend stores. Not part of the public surface, which reports deliveries
   * per queue and nothing about messages, so each backend reads its own storage.
   */
  retained(): Promise<Retained>;
  teardown(): Promise<void>;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function parseEntry<T>(data: Uint8Array): T {
  return JSON.parse(dec.decode(data).trim());
}

export type ConformanceOpts = {
  ignore?: boolean;
  sanitize?: boolean;
};

export function queueConformanceTests(name: string, setup: () => Promise<QueueSetup>, opts?: ConformanceOpts) {
  Deno.test({
    name,
    ignore: opts?.ignore ?? false,
    sanitizeResources: opts?.sanitize ?? true,
    sanitizeOps: opts?.sanitize ?? true,
  }, async (t) => {
    const { registry, router, retained, teardown } = await setup();

    try {
      await t.step('touch creates, stat reports routing keys and size', async () => {
        assertEquals(await registry.touch('q1', { routingKeys: ['evt.test'] }), true);
        assertEquals(await registry.touch('q1', { routingKeys: ['evt.test'] }), false);
        assertEquals(await registry.exists('q1'), true);

        const stat = await registry.stat('q1');
        assertEquals(stat.routingKeys, ['evt.test']);
        assertEquals(stat.size, 0);
        assertEquals(stat.inFlight, 0);
        assertEquals(stat.oldestInFlightMs, 0);
        assertEquals(stat.deadLettered, 0);
      });

      await t.step('size counts what is claimable, not what a consumer holds', async () => {
        await registry.touch('split', { routingKeys: [] });

        const handle = await registry.open('split', {}, 'r+');
        try {
          await handle.write(enc.encode(JSON.stringify({ n: 1 }) + '\n'));
          assertEquals((await registry.stat('split')).size, 1);

          parseEntry(await handle.read(1));

          // The entry has not gone anywhere, but it is no longer backlog. Summed,
          // the two would report an unchanging depth for a queue that is
          // draining — and for one that is not consuming at all.
          const held = await registry.stat('split');
          assertEquals(held.size, 0);
          assertEquals(held.inFlight, 1);

          await handle.write(enc.encode('ack\n'));

          const drained = await registry.stat('split');
          assertEquals(drained.size, 0);
          assertEquals(drained.inFlight, 0);
        } finally {
          await handle.close();
        }
      });

      await t.step('an expired lease hands a stranded entry back', async () => {
        await registry.touch('lease', { routingKeys: [] });

        const writer = await registry.open('lease', {}, 'a');
        try {
          await writer.write(enc.encode(JSON.stringify({ n: 1 }) + '\n'));
        } finally {
          await writer.close();
        }

        // A consumer that takes the entry and dies: no ack, no nack, no close.
        // Without a lease this is where the entry stays forever.
        const dead = await registry.open('lease', { leaseMs: 50 }, 'r+');
        try {
          assertEquals(parseEntry(await dead.read(1)), { n: 1 });
          assertEquals((await registry.stat('lease')).inFlight, 1);

          await new Promise((r) => setTimeout(r, 80));

          const rescuer = await registry.open('lease', { leaseMs: 50 }, 'r+');
          try {
            assertEquals(parseEntry(await rescuer.read(1)), { n: 1 });
            await rescuer.write(enc.encode('ack\n'));
          } finally {
            await rescuer.close();
          }

          const stat = await registry.stat('lease');
          assertEquals(stat.size, 0);
          assertEquals(stat.inFlight, 0);
        } finally {
          await dead.close();
        }
      });

      await t.step('an entry that always fails is dead-lettered, not retried forever', async () => {
        await registry.touch('poison', { routingKeys: [] });

        const writer = await registry.open('poison', {}, 'a');
        try {
          await writer.write(enc.encode(JSON.stringify({ poison: true }) + '\n'));
        } finally {
          await writer.close();
        }

        // A consumer that can never process this entry. Without a bound this
        // loop never ends: nack only clears the lock, so the next poll tick —
        // at most a second later — hands the same entry straight back.
        const handle = await registry.open('poison', { maxAttempts: 3 }, 'r+');
        try {
          for (let i = 0; i < 3; i++) {
            assertEquals(parseEntry(await handle.read(1)), { poison: true }, `attempt ${i + 1} should be delivered`);
            await handle.write(enc.encode('nack\n'));
          }

          // Fourth read finds nothing: the entry used up its attempts.
          assertEquals((await handle.read(1)).length, 0);
        } finally {
          await handle.close();
        }

        // Still a row, and counted apart from the live numbers — a dead entry
        // is neither backlog nor work in progress. Deleting it would leave
        // nothing to explain why the work never happened.
        const stat = await registry.stat('poison');
        assertEquals(stat.size, 0);
        assertEquals(stat.inFlight, 0);
        assertEquals(stat.deadLettered, 1);

        // A consumer without the bound must not resurrect it either: the state
        // lives on the delivery, not in the reader's policy.
        const other = await registry.open('poison', { maxAttempts: 0 }, 'r+');
        try {
          assertEquals((await other.read(1)).length, 0);
        } finally {
          await other.close();
        }
      });

      await t.step('a crash-looping consumer exhausts attempts through the lease too', async () => {
        await registry.touch('poison-lease', { routingKeys: [] });

        const writer = await registry.open('poison-lease', {}, 'a');
        try {
          await writer.write(enc.encode(JSON.stringify({ poison: 'lease' }) + '\n'));
        } finally {
          await writer.close();
        }

        // A consumer that dies holding the entry never nacks it, so bounding
        // only the nack would leave this variant redelivering forever.
        for (let i = 0; i < 2; i++) {
          const dead = await registry.open('poison-lease', { leaseMs: 50, maxAttempts: 2 }, 'r+');
          assertEquals(parseEntry(await dead.read(1)), { poison: 'lease' }, `delivery ${i + 1}`);
          // No ack, no nack, no close — the process is gone.
          await new Promise((r) => setTimeout(r, 80));
        }

        const reader = await registry.open('poison-lease', { leaseMs: 50, maxAttempts: 2 }, 'r+');
        try {
          assertEquals((await reader.read(1)).length, 0);
        } finally {
          await reader.close();
        }

        const stat = await registry.stat('poison-lease');
        assertEquals(stat.size, 0);
        assertEquals(stat.inFlight, 0);
        assertEquals(stat.deadLettered, 1);
      });

      await t.step('maxAttempts 0 keeps retrying', async () => {
        await registry.touch('unbounded', { routingKeys: [] });

        const writer = await registry.open('unbounded', {}, 'a');
        try {
          await writer.write(enc.encode(JSON.stringify({ n: 1 }) + '\n'));
        } finally {
          await writer.close();
        }

        const handle = await registry.open('unbounded', { maxAttempts: 0 }, 'r+');
        try {
          for (let i = 0; i < 4; i++) {
            assertEquals(parseEntry(await handle.read(1)), { n: 1 });
            await handle.write(enc.encode('nack\n'));
          }
        } finally {
          await handle.close();
        }

        const stat = await registry.stat('unbounded');
        assertEquals(stat.size, 1);
        assertEquals(stat.deadLettered, 0);
      });

      await t.step('an entry arriving after close is handed back, not stranded', async () => {
        await registry.touch('closerace', { routingKeys: [] });

        const reader = await registry.open('closerace', {}, 'r+');
        const ac = new AbortController();
        const pending = reader.read(1, ac.signal);

        // Close while the read is parked, then let an entry arrive. It resolves
        // onto a handle whose close() has already run its nack step, so the
        // handle has to hand this one back itself.
        await reader.close();

        const writer = await registry.open('closerace', {}, 'a');
        try {
          await writer.write(enc.encode(JSON.stringify({ n: 1 }) + '\n'));
        } finally {
          await writer.close();
        }

        assertEquals((await pending).length, 0);

        await waitFor(async () => (await registry.stat('closerace')).size === 1);

        const stat = await registry.stat('closerace');
        assertEquals(stat.size, 1);
        assertEquals(stat.inFlight, 0);

        ac.abort();
      });

      await t.step('peek shows what is waiting and held, in order, and consumes nothing', async () => {
        await registry.touch('peeked', { routingKeys: [] });

        const writer = await registry.open('peeked', {}, 'a');
        try {
          for (const n of [1, 2, 3]) await writer.write(enc.encode(JSON.stringify({ n }) + '\n'));
        } finally {
          await writer.close();
        }

        const first = await registry.peek('peeked', 10);
        assertEquals(first.map((entry) => entry.data), [{ n: 1 }, { n: 2 }, { n: 3 }]);
        assertEquals(first.map((entry) => entry.state), ['ready', 'ready', 'ready']);
        assertEquals(first.map((entry) => entry.attempts), [0, 0, 0]);
        assertEquals((await registry.peek('peeked', 2)).length, 2);
        // Peeking twice changes nothing: no claim, no attempt spent.
        assertEquals(await registry.peek('peeked', 10), first);
        assertEquals((await registry.stat('peeked')).size, 3);

        // A held entry stays in its place, marked as held.
        const consumer = await registry.open('peeked', {}, 'r+');
        try {
          assertEquals(parseEntry(await consumer.read(1)), { n: 1 });
          const held = await registry.peek('peeked', 10);
          assertEquals(held.map((entry) => [entry.state, entry.attempts]), [['in-flight', 1], ['ready', 0], ['ready', 0]]);
          await consumer.write(enc.encode('ack\n'));
        } finally {
          await consumer.close();
        }

        assertEquals((await registry.peek('peeked', 10)).map((entry) => entry.data), [{ n: 2 }, { n: 3 }]);
        // Dead-lettered entries are counted by stat, not listed.
        assertEquals(await registry.peek('poison', 10), []);
        await assertRejects(() => registry.peek('no-such-queue', 10));
      });

      await t.step('dead letters are listed, and retried or dropped by a person', async () => {
        await registry.touch('settled', { routingKeys: [] });

        const writer = await registry.open('settled', {}, 'a');
        try {
          for (const n of [1, 2, 3]) await writer.write(enc.encode(JSON.stringify({ n }) + '\n'));
        } finally {
          await writer.close();
        }

        // One attempt each: the first two die, the third stays live.
        const failing = await registry.open('settled', { maxAttempts: 1 }, 'r+');
        try {
          for (let i = 0; i < 2; i++) {
            await failing.read(1);
            await failing.write(enc.encode('nack\n'));
          }
        } finally {
          await failing.close();
        }

        const dead = await registry.deadLetters('settled', 10);
        assertEquals(dead.map((entry) => [entry.data, entry.attempts]), [[{ n: 1 }, 1], [{ n: 2 }, 1]]);
        assertEquals(dead.every((entry) => entry.deadAt instanceof Date), true);
        assertEquals((await registry.deadLetters('settled', 1)).length, 1);

        // A live entry is not dead, so naming it settles nothing.
        const live = (await registry.peek('settled', 10))[0].id;
        assertEquals(await registry.settleDead('settled', 'retry', [live]), 0);

        assertEquals(await registry.settleDead('settled', 'retry', [dead[0].id]), 1);
        const peeked = await registry.peek('settled', 10);
        assertEquals(peeked.map((entry) => [entry.data, entry.state, entry.attempts]), [[{ n: 1 }, 'ready', 0], [{ n: 3 }, 'ready', 0]]);

        assertEquals(await registry.settleDead('settled', 'drop'), 1);
        assertEquals(await registry.deadLetters('settled', 10), []);
        assertEquals((await registry.stat('settled')).deadLettered, 0);

        // The retried entry is handed out again.
        const reader = await registry.open('settled', {}, 'r+');
        try {
          assertEquals(parseEntry(await reader.read(1)), { n: 1 });
          await reader.write(enc.encode('ack\n'));
        } finally {
          await reader.close();
        }

        await assertRejects(() => registry.deadLetters('no-such-queue', 10));
        await assertRejects(() => registry.settleDead('no-such-queue', 'drop'));
      });

      await t.step('append and read roundtrip with explicit ack', async () => {
        const handle = await registry.open('q1', {}, 'r+');
        try {
          await handle.write(enc.encode(JSON.stringify({ n: 1 }) + '\n'));
          assertEquals((await registry.stat('q1')).size, 1);

          const entry = parseEntry<{ n: number }>(await handle.read(1));
          assertEquals(entry, { n: 1 });

          await handle.write(enc.encode('ack\n'));
          assertEquals((await registry.stat('q1')).size, 0);
        } finally {
          await handle.close();
        }
      });

      await t.step('nack makes the entry deliverable again', async () => {
        const handle = await registry.open('q1', {}, 'r+');
        try {
          await handle.write(enc.encode(JSON.stringify({ n: 2 }) + '\n'));

          const first = parseEntry<{ n: number }>(await handle.read(1));
          assertEquals(first, { n: 2 });

          await handle.write(enc.encode('nack\n'));

          const again = parseEntry<{ n: number }>(await handle.read(1));
          assertEquals(again, { n: 2 });

          await handle.write(enc.encode('ack\n'));
        } finally {
          await handle.close();
        }
      });

      await t.step('close nacks the in-flight entry', async () => {
        const h1 = await registry.open('q1', {}, 'r+');
        await h1.write(enc.encode(JSON.stringify({ n: 3 }) + '\n'));
        const locked = parseEntry<{ n: number }>(await h1.read(1));
        assertEquals(locked, { n: 3 });

        // Close without ack — entry must become deliverable again
        await h1.close();

        const h2 = await registry.open('q1', {}, 'r+');
        try {
          const redelivered = parseEntry<{ n: number }>(await h2.read(1));
          assertEquals(redelivered, { n: 3 });
          await h2.write(enc.encode('ack\n'));
        } finally {
          await h2.close();
        }
      });

      await t.step('r mode auto-acks entries', async () => {
        const writer = await registry.open('q1', {}, 'a');
        try {
          await writer.write(enc.encode(JSON.stringify({ n: 4 }) + '\n' + JSON.stringify({ n: 5 }) + '\n'));
        } finally {
          await writer.close();
        }

        const reader = await registry.open('q1', {}, 'r');
        try {
          assertEquals(parseEntry(await reader.read(1)), { n: 4 });
          assertEquals(parseEntry(await reader.read(1)), { n: 5 });
          assertEquals((await registry.stat('q1')).size, 0);
        } finally {
          await reader.close();
        }
      });

      await t.step('read without signal returns empty on drained queue', async () => {
        const reader = await registry.open('q1', {}, 'r');
        try {
          assertEquals((await reader.read(1)).length, 0);
        } finally {
          await reader.close();
        }
      });

      await t.step('blocking read resolves when an entry arrives', async () => {
        const reader = await registry.open('q1', {}, 'r');
        const writer = await registry.open('q1', {}, 'a');
        try {
          const ac = new AbortController();
          const pending = reader.read(1, ac.signal);

          await writer.write(enc.encode(JSON.stringify({ n: 6 }) + '\n'));

          assertEquals(parseEntry(await pending), { n: 6 });
        } finally {
          await reader.close();
          await writer.close();
        }
      });

      await t.step('blocking read returns empty on abort, holding nothing', async () => {
        const reader = await registry.open('q1', {}, 'r');
        try {
          const ac = new AbortController();
          const pending = reader.read(1, ac.signal);
          ac.abort();
          assertEquals((await pending).length, 0);

          // An abort landing on a claim already in flight must give the row
          // back, or it stays locked until its lease lapses.
          assertEquals((await registry.stat('q1')).inFlight, 0);
        } finally {
          await reader.close();
        }
      });

      await t.step('routed message fans out to all bound queues', async () => {
        await registry.touch('fan-a', { routingKeys: ['evt.fan'] });
        await registry.touch('fan-b', { routingKeys: ['evt.fan'] });
        await registry.touch('fan-other', { routingKeys: ['evt.other'] });

        router.publish('evt.fan', { fan: true });

        await waitFor(async () => (await registry.stat('fan-a')).size === 1 && (await registry.stat('fan-b')).size === 1);

        assertEquals((await registry.stat('fan-a')).size, 1);
        assertEquals((await registry.stat('fan-b')).size, 1);
        assertEquals((await registry.stat('fan-other')).size, 0);

        for (const q of ['fan-a', 'fan-b']) {
          const h = await registry.open(q, {}, 'r');
          try {
            assertEquals(parseEntry(await h.read(1)), { fan: true });
          } finally {
            await h.close();
          }
        }
      });

      await t.step('a pattern binding fans out by segment', async () => {
        await registry.touch('pat-star', { routingKeys: ['system.vfs.file.*'] });
        await registry.touch('pat-hash', { routingKeys: ['media.#'] });
        await registry.touch('pat-exact', { routingKeys: ['system.vfs.file.created'] });

        router.publish('system.vfs.file.created', { n: 1 });
        router.publish('system.vfs.file.updated', { n: 2 });
        // Neither pattern reaches these: `*` is one segment, and `media.#` is anchored at `media`.
        router.publish('system.vfs.file.a.b', { n: 3 });
        router.publish('system.vfs.tty.updated', { n: 4 });
        router.publish('media', { n: 5 });
        router.publish('media.face.detected', { n: 6 });

        await waitFor(async () =>
          (await registry.stat('pat-star')).size === 2 &&
          (await registry.stat('pat-hash')).size === 2 &&
          (await registry.stat('pat-exact')).size === 1
        );

        assertEquals((await registry.stat('pat-star')).size, 2);
        assertEquals((await registry.stat('pat-hash')).size, 2);
        assertEquals((await registry.stat('pat-exact')).size, 1);

        // Both entries, compared as a set. The relay fans each publish out on its own
        // macrotask and the fanout INSERTs then race for their sequence values, so the
        // delivery order of two separately published events is not fixed — a queue
        // orders what it hands out by delivery id, not by the order publish() was
        // called in.
        const h = await registry.open('pat-star', {}, 'r');
        try {
          const seen = [parseEntry<{ n: number }>(await h.read(1)), parseEntry<{ n: number }>(await h.read(1))];
          assertEquals(seen.map((e) => e.n).toSorted(), [1, 2]);
        } finally {
          await h.close();
        }
      });

      await t.step('rebinding from a pattern narrows again', async () => {
        // The pattern must not survive as a stale binding once the queue asks for one key.
        assertEquals(await registry.touch('pat-star', { routingKeys: ['system.vfs.file.created'] }), true);
        assertEquals((await registry.stat('pat-star')).routingKeys, ['system.vfs.file.created']);

        const before = (await registry.stat('pat-star')).size;
        router.publish('system.vfs.file.updated', { n: 7 });
        // Nothing to wait *for* here, so this one is a settle: long enough that a delivery that was
        // going to happen has happened.
        await new Promise((r) => setTimeout(r, 500));

        assertEquals((await registry.stat('pat-star')).size, before);
      });

      // Every event published anywhere in the instance reaches the relay, and most routing keys
      // have no queue bound. A message is freed only when its last delivery is acked, so one
      // stored with no delivery would never be freed: an unmatched event must not be stored.
      await t.step('an unsubscribed routing key retains nothing', async () => {
        await registry.touch('relay-bound', { routingKeys: ['relay.wanted'] });
        const before = await retained();

        for (let i = 0; i < 100; i++) router.publish('relay.nobody', { i });
        // Published last, so once it has arrived the relay has passed every event above.
        router.publish('relay.wanted', { marker: true });
        await waitFor(async () => (await registry.stat('relay-bound')).size === 1);

        assertEquals((await registry.stat('relay-bound')).size, 1);
        assertEquals(await retained(), { messages: before.messages + 1, deliveries: before.deliveries + 1 });

        const h = await registry.open('relay-bound', {}, 'r');
        try {
          assertEquals(parseEntry(await h.read(1)), { marker: true });
        } finally {
          await h.close();
        }
      });

      await t.step('a subscription receives from its commit on, not before', async () => {
        for (let i = 0; i < 3; i++) {
          const key = `relay.late.${i}`;
          router.publish(key, { early: true });
          router.publish('relay.wanted', { marker: i });
          await waitFor(async () => (await registry.stat('relay-bound')).size === 1);

          // No settle between subscribing and publishing: whatever the backend keeps to skip
          // unbound keys must already know the key once touch() has returned.
          await registry.touch(`relay-late-${i}`, { routingKeys: [key] });
          router.publish(key, { early: false });
          await waitFor(async () => (await registry.stat(`relay-late-${i}`)).size === 1);

          const h = await registry.open(`relay-late-${i}`, {}, 'r');
          try {
            assertEquals(parseEntry(await h.read(1)), { early: false }, `${key} delivers after touch, and only then`);
            assertEquals((await h.read(1)).length, 0);
          } finally {
            await h.close();
          }

          const marker = await registry.open('relay-bound', {}, 'r');
          try {
            assertEquals(parseEntry(await marker.read(1)), { marker: i });
          } finally {
            await marker.close();
          }
        }
      });

      // Wrong in either direction and nothing above this layer notices: too narrow and every
      // acked message is kept forever, too wide and a fanned-out message is freed from under
      // the queue still holding it.
      await t.step('acking the last delivery frees the message, acking one of two does not', async () => {
        await registry.touch('ack-a', { routingKeys: ['relay.ack'] });
        await registry.touch('ack-b', { routingKeys: ['relay.ack'] });
        const before = await retained();
        const plus = (messages: number, deliveries: number) => ({
          messages: before.messages + messages,
          deliveries: before.deliveries + deliveries,
        });

        const ackOne = async (queue: string) => {
          const handle = await registry.open(queue, {}, 'r+');
          try {
            assertEquals(parseEntry(await handle.read(1)), { fanned: true });
            await handle.write(enc.encode('ack\n'));
          } finally {
            await handle.close();
          }
        };

        router.publish('relay.ack', { fanned: true });
        await waitFor(async () => (await registry.stat('ack-a')).size === 1 && (await registry.stat('ack-b')).size === 1);
        assertEquals(await retained(), plus(1, 2), 'one message fanned out to both queues');

        await ackOne('ack-a');
        assertEquals(await retained(), plus(1, 1), 'the message stays while the other delivery is outstanding');
        assertEquals((await registry.stat('ack-b')).size, 1);

        await ackOne('ack-b');
        assertEquals(await retained(), before, 'the last ack takes the message with it');
      });

      await t.step('concurrent acks of a fanned-out message leave no message behind', async () => {
        const count = 200;
        await registry.touch('race-a', { routingKeys: ['relay.race'] });
        await registry.touch('race-b', { routingKeys: ['relay.race'] });
        const before = await retained();

        for (let i = 0; i < count; i++) router.publish('relay.race', { i });
        await waitFor(async () => (await registry.stat('race-a')).size === count && (await registry.stat('race-b')).size === count);

        // Mode 'r' acks on read, the way the durable consumers run.
        const drain = async (queue: string): Promise<number> => {
          const handle = await registry.open(queue, {}, 'r');
          try {
            let read = 0;
            while ((await handle.read(1)).length > 0) read++;
            return read;
          } finally {
            await handle.close();
          }
        };

        assertEquals(await Promise.all([drain('race-a'), drain('race-b')]), [count, count]);
        assertEquals(await retained(), before, 'every message went with its last delivery');
      });

      await t.step('competing consumers receive disjoint entries', async () => {
        await registry.touch('work', { routingKeys: [] });

        const writer = await registry.open('work', {}, 'a');
        try {
          await writer.write(enc.encode(JSON.stringify({ job: 'a' }) + '\n' + JSON.stringify({ job: 'b' }) + '\n'));
        } finally {
          await writer.close();
        }

        const c1 = await registry.open('work', {}, 'r');
        const c2 = await registry.open('work', {}, 'r');
        try {
          const e1 = parseEntry<{ job: string }>(await c1.read(1));
          const e2 = parseEntry<{ job: string }>(await c2.read(1));

          assertEquals([e1.job, e2.job].toSorted(), ['a', 'b']);
        } finally {
          await c1.close();
          await c2.close();
        }
      });

      await t.step('w mode truncates pending entries', async () => {
        await registry.touch('trunc', { routingKeys: [] });

        const writer = await registry.open('trunc', {}, 'a');
        try {
          await writer.write(enc.encode(JSON.stringify({ n: 1 }) + '\n'));
        } finally {
          await writer.close();
        }
        assertEquals((await registry.stat('trunc')).size, 1);

        const truncator = await registry.open('trunc', {}, 'w');
        await truncator.close();
        assertEquals((await registry.stat('trunc')).size, 0);
      });

      await t.step('delete removes the queue', async () => {
        assertEquals(await registry.delete('trunc'), true);
        assertEquals(await registry.exists('trunc'), false);
        await assertRejects(() => registry.stat('trunc'));
      });
    } finally {
      await teardown();
    }
  });
}
