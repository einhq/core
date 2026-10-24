/**
 * Router node semantics: writes are published on the node's routing key as JSONL,
 * a node without a routing key publishes nothing, and readers tail the key.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { RouterManager } from '../../../managers/router/mod.ts';
import { MemoryQueueRegistry } from '../../queue/mod.ts';
import { RouterRegistry } from '../mod.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const setup = async () => {
  const router = new RouterManager();
  await router.init();
  router.release();

  const registry = new RouterRegistry({ router });
  await registry.init();

  const published: { routingKey: string; payload: unknown }[] = [];
  router.on(async (routingKey, payload) => {
    published.push({ routingKey, payload });
  });

  const waitFor = async (predicate: () => boolean, timeoutMs = 2000) => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for publish');
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  return {
    router,
    registry,
    published,
    waitFor,
    async dispose() {
      await registry.dispose();
      await router.dispose();
    },
  };
};

Deno.test('router registry', async (t) => {
  const ctx = await setup();

  try {
    await t.step('a write publishes the parsed JSON value on the routing key', async () => {
      const handle = await ctx.registry.open('events', { routingKey: 'system.events' }, 'a');
      await handle.write(encoder.encode('{"type":"media.file.discovered","subject":"/a.jpg"}\n'));
      await handle.close();

      await ctx.waitFor(() => ctx.published.length > 0);

      assertEquals(ctx.published[0].routingKey, 'system.events');
      assertEquals(ctx.published[0].payload, { type: 'media.file.discovered', subject: '/a.jpg' });
    });

    await t.step('a multi-line write publishes one message per line', async () => {
      ctx.published.length = 0;

      const handle = await ctx.registry.open('events', { routingKey: 'system.events' }, 'a');
      await handle.write(encoder.encode('{"n":1}\n{"n":2}\n\n{"n":3}\n'));
      await handle.close();

      await ctx.waitFor(() => ctx.published.length === 3);

      assertEquals(ctx.published.map((p) => p.payload), [{ n: 1 }, { n: 2 }, { n: 3 }]);
    });

    await t.step('non-JSON lines are published as text', async () => {
      ctx.published.length = 0;

      const handle = await ctx.registry.open('events', { routingKey: 'system.events' }, 'a');
      await handle.write(encoder.encode('not json\n'));
      await handle.close();

      await ctx.waitFor(() => ctx.published.length > 0);

      assertEquals(ctx.published[0].payload, 'not json');
    });

    await t.step('a node without a routing key publishes nothing', async () => {
      ctx.published.length = 0;

      const handle = await ctx.registry.open('null', {}, 'a');
      await handle.write(encoder.encode('discarded output\n'));
      await handle.close();

      // Nothing to wait for — give the fanout a macrotask to prove it stays empty
      await new Promise((r) => setTimeout(r, 20));

      assertEquals(ctx.published, []);
    });

    await t.step('a reader tails everything published on the key', async () => {
      const reader = await ctx.registry.open('events', { routingKey: 'system.events' }, 'r');
      const read = reader.read(1);

      // Published by an unrelated producer, not through the node itself
      ctx.router.publish('system.events', { type: 'media.face.detected' });

      const data = await read;
      assertEquals(JSON.parse(decoder.decode(data).trim()), { type: 'media.face.detected' });

      await reader.close();
    });

    await t.step('a pattern node tails every key it covers, and nothing else', async () => {
      // Created the way `mknode -t router --as routingKey=…` creates one: a read-only tail is
      // never opened for writing, so nothing else would bring the node into being.
      await ctx.registry.touch('vfs-tail', { routingKey: 'system.vfs.#' });

      const reader = await ctx.registry.open('vfs-tail', { routingKey: 'system.vfs.#' }, 'r');
      const read = reader.read(1);

      // Outside the pattern: if this resolved the read, the assert below would see it instead.
      ctx.router.publish('media.face.detected', { wrong: true });
      ctx.router.publish('system.vfs.file.created', { path: '/a.jpg' });

      assertEquals(JSON.parse(decoder.decode(await read).trim()), { path: '/a.jpg' });

      await reader.close();
    });

    await t.step('an exact node is unaffected by a pattern that would cover it', async () => {
      const reader = await ctx.registry.open('events', { routingKey: 'system.events' }, 'r');
      const read = reader.read(1);

      ctx.router.publish('system.vfs.file.created', { wrong: true });
      ctx.router.publish('system.events', { type: 'media.file.discovered' });

      assertEquals(JSON.parse(decoder.decode(await read).trim()), { type: 'media.file.discovered' });

      await reader.close();
    });

    await t.step('the pattern is re-registered after its last reader leaves', async () => {
      // The previous step closed the only reader on `vfs-tail`, which drops the compiled pattern
      // along with the empty waiter set. A second reader must put it back.
      const reader = await ctx.registry.open('vfs-tail', { routingKey: 'system.vfs.#' }, 'r');
      const read = reader.read(1);

      ctx.router.publish('system.vfs.exif.updated', { again: true });

      assertEquals(JSON.parse(decoder.decode(await read).trim()), { again: true });

      await reader.close();
    });

    await t.step('writing to a pattern node is rejected', async () => {
      const handle = await ctx.registry.open('vfs-tail', { routingKey: 'system.vfs.#' }, 'a');

      // A pattern says which keys to tail; there is no single key it could publish on.
      await assertRejects(
        () => handle.write(encoder.encode('{"n":1}\n')),
        Error,
        'cannot publish to a routing key pattern: system.vfs.#',
      );

      await handle.close();

      // Filtered rather than cleared: publishes from earlier steps land on this collector via a
      // macrotask and can arrive after a step boundary, so an emptiness check would be a race.
      await new Promise((r) => setTimeout(r, 20));
      assertEquals(ctx.published.filter((p) => p.routingKey === 'system.vfs.#'), []);
    });

    await t.step('stat reports the routing key and live subscribers', async () => {
      const stat = await ctx.registry.stat('events');

      assertEquals(stat.routingKey, 'system.events');
      assertEquals(stat.subscribers, 0);
    });
  } finally {
    await ctx.dispose();
  }
});

/**
 * The path the archive bridge and the pipeline engine rely on: a producer writes
 * JSON to a router node, a queue node bound to the same key receives it durably.
 */
Deno.test('router node write lands on a bound queue', async () => {
  const router = new RouterManager();
  await router.init();
  router.release();

  const routers = new RouterRegistry({ router });
  const queues = new MemoryQueueRegistry({ router });
  await routers.init();
  await queues.init();

  try {
    const queue = await queues.open('pipeline-engine', { routingKeys: ['system.events'] }, 'r+');

    const events = await routers.open('events', { routingKey: 'system.events' }, 'a');
    await events.write(encoder.encode('{"type":"media.metadata.extracted","subject":"/a.jpg"}\n'));
    await events.close();

    // Relay delivery is deferred to a macrotask, so the read must block on a signal
    const entry = decoder.decode(await queue.read(1, AbortSignal.timeout(2000))).trim();

    assertEquals(JSON.parse(entry), { type: 'media.metadata.extracted', subject: '/a.jpg' });

    await queue.write(encoder.encode('ack\n'));
    await queue.close();
  } finally {
    await queues.dispose();
    await routers.dispose();
    await router.dispose();
  }
});
