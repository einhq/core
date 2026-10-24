/**
 * PG tier: queue conformance against PostgreSQL plus durability across
 * registry re-instantiation. Gated by EIN_TEST_PG.
 */

import { assert, assertEquals } from '@std/assert';
import { RouterManager } from '../../../managers/router/mod.ts';
import { PG_URL, pgTest, pgTestContext } from '../../../testing/gates.ts';
import { routingPatternToRegexSource } from '../../routing-key-match.ts';
import { MATCH_CASES } from '../../test/routing-key-cases.ts';
import { PgQueueRegistry } from '../mod.ts';
import { queueConformanceTests } from './queue-conformance.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

queueConformanceTests('PgQueueRegistry conformance', async () => {
  const ctx = pgTestContext();
  const router = new RouterManager();
  await router.init();
  router.release();

  const registry = new PgQueueRegistry({ name: ctx.prefix, pool: ctx.pool, router });
  await registry.init();

  return {
    registry,
    router,
    retained: async () => {
      const res = await ctx.pool.query<{ messages: number; deliveries: number }>(`
        SELECT
          (SELECT count(*)::int FROM ${ctx.prefix}_queues_msg) AS messages,
          (SELECT count(*)::int FROM ${ctx.prefix}_queues_lnk) AS deliveries
      `);
      return res.rows[0];
    },
    teardown: async () => {
      await registry.dispose();
      await router.dispose();
      await ctx.teardown();
    },
  };
}, { ignore: !PG_URL, sanitize: false });

pgTest('init deletes messages no delivery refers to and keeps the rest', async () => {
  const ctx = pgTestContext();
  const router = new RouterManager();
  await router.init();
  router.release();

  const first = new PgQueueRegistry({ name: ctx.prefix, pool: ctx.pool, router });
  await first.init();

  const messages = async (): Promise<number> => {
    const res = await ctx.pool.query(`SELECT count(*)::int AS n FROM ${ctx.prefix}_queues_msg`);
    return res.rows[0].n;
  };

  let second: PgQueueRegistry | undefined;
  try {
    await first.touch('kept', { routingKeys: ['kept.key'] });
    router.publish('kept.key', { pending: true });
    // The publish is persisted asynchronously; wait for its row rather than for a fixed time.
    for (let i = 0; i < 100 && await messages() < 1; i++) await new Promise((resolve) => setTimeout(resolve, 50));

    await ctx.pool.query(
      `INSERT INTO ${ctx.prefix}_queues_msg (routing_key, payload) SELECT 'leaked', 'null'::jsonb FROM generate_series(1, 3)`,
    );
    assertEquals(await messages(), 4);

    await first.dispose();
    second = new PgQueueRegistry({ name: ctx.prefix, pool: ctx.pool, router });
    await second.init();

    assertEquals(await messages(), 1, 'the orphans are gone, the pending message is not');
    assertEquals((await second.stat('kept')).size, 1);
  } finally {
    await (second ?? first).dispose();
    await router.dispose();
    await ctx.teardown();
  }
});

pgTest('PgQueueRegistry durability across re-instantiation', async () => {
  const ctx = pgTestContext();
  const router = new RouterManager();
  await router.init();
  router.release();

  try {
    // First registry instance: create a queue and append an entry
    {
      const registry = new PgQueueRegistry({ name: ctx.prefix, pool: ctx.pool, router });
      await registry.init();

      const handle = await registry.open('durable', { routingKeys: [] }, 'a');
      try {
        await handle.write(enc.encode(JSON.stringify({ survives: true }) + '\n'));
      } finally {
        await handle.close();
      }

      await registry.dispose();
    }

    // Second registry instance: the entry is still there and deliverable
    {
      const registry = new PgQueueRegistry({ name: ctx.prefix, pool: ctx.pool, router });
      await registry.init();

      assertEquals((await registry.stat('durable')).size, 1);

      const handle = await registry.open('durable', {}, 'r');
      try {
        const entry = JSON.parse(dec.decode(await handle.read(1)).trim());
        assertEquals(entry, { survives: true });
      } finally {
        await handle.close();
      }

      await registry.dispose();
    }
  } finally {
    await router.dispose();
    await ctx.teardown();
  }
});

/**
 * Stronger than retaining nothing: an unbound key must not reach postgres at
 * all. Writing nothing would still cost a pooled client and a round-trip per
 * event, and every VFS mutation publishes.
 *
 * Counting `pool.connect` rather than table stats because it is exactly the
 * resource under contention, and because `pg_stat_user_tables` updates
 * asynchronously and would make this flaky.
 */
pgTest('PgQueueRegistry takes no connection for an unbound routing key', async () => {
  const ctx = pgTestContext();
  const router = new RouterManager();
  await router.init();
  router.release();

  const registry = new PgQueueRegistry({ name: ctx.prefix, pool: ctx.pool, router });
  await registry.init();

  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

  try {
    await registry.touch('bound', { routingKeys: ['wanted.key'] });
    await settle(); // let the subscriptions NOTIFY land before counting

    const original = ctx.pool.connect.bind(ctx.pool);
    let connects = 0;
    // deno-lint-ignore no-explicit-any
    (ctx.pool as any).connect = (...args: unknown[]) => {
      connects++;
      // deno-lint-ignore no-explicit-any
      return (original as any)(...args);
    };

    try {
      for (let i = 0; i < 25; i++) {
        router.publish('system.vfs.tty.updated', { n: i });
      }
      await settle();
      assertEquals(connects, 0, 'unbound keys must not touch the pool');

      router.publish('wanted.key', { delivered: true });
      await settle();
      assertEquals(connects, 1, 'a bound key still goes to postgres exactly once');
    } finally {
      // deno-lint-ignore no-explicit-any
      (ctx.pool as any).connect = original;
    }
  } finally {
    await registry.dispose();
    await router.dispose();
    await ctx.teardown();
  }
});

pgTest('PgQueueRegistry fans out messages published together in a few statements, in publish order', async () => {
  const ctx = pgTestContext();
  const router = new RouterManager();
  await router.init();
  router.release();

  const registry = new PgQueueRegistry({ name: ctx.prefix, pool: ctx.pool, router });
  await registry.init();

  const MESSAGES = 1_200;
  try {
    await registry.touch('files', { routingKeys: ['system.vfs.file.moved'] });
    await registry.touch('all', { routingKeys: ['system.vfs.#'] });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const original = ctx.pool.connect.bind(ctx.pool);
    let connects = 0;
    // deno-lint-ignore no-explicit-any
    (ctx.pool as any).connect = (...args: unknown[]) => {
      connects++;
      // deno-lint-ignore no-explicit-any
      return (original as any)(...args);
    };
    try {
      for (let i = 0; i < MESSAGES; i++) router.publish(i % 2 === 0 ? 'system.vfs.file.moved' : 'system.vfs.file.updated', { n: i });
      // Settled once no statement started in the last 200 ms.
      for (let before = -1; before !== connects;) {
        before = connects;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } finally {
      // deno-lint-ignore no-explicit-any
      (ctx.pool as any).connect = original;
    }
    // One statement for the first message, then one per batch of at most 500 of those that waited.
    assert(connects <= 1 + Math.ceil(MESSAGES / 500) + 2, `${connects} connections for ${MESSAGES} messages`);

    const order = async (queue: string): Promise<number[]> => {
      const res = await ctx.pool.query<{ n: number }>(
        `SELECT (m.payload->>'n')::int AS n FROM ${ctx.prefix}_queues_lnk d JOIN ${ctx.prefix}_queues_msg m ON m.id = d.message_id
         WHERE d.subscription_id = $1 ORDER BY d.id`,
        [queue],
      );
      return res.rows.map((row) => row.n);
    };
    assertEquals(await order('all'), Array.from({ length: MESSAGES }, (_, i) => i));
    assertEquals(await order('files'), Array.from({ length: MESSAGES / 2 }, (_, i) => 2 * i));
  } finally {
    await registry.dispose();
    await router.dispose();
    await ctx.teardown();
  }
});

/**
 * A consumer parked on an empty queue must not hold a pooled client.
 *
 * `read` acquires one for its first claim attempt and releases it before the
 * blocking LISTEN/NOTIFY wait: the poll and the NOTIFY handler both claim through
 * `this.pool`, and consumers stay parked for good.
 *
 * Checked-out count rather than a connect counter: what matters is how long
 * clients are kept, not how many are taken.
 */
pgTest('PgQueueRegistry holds no pooled client while a consumer waits', async () => {
  const ctx = pgTestContext();
  const router = new RouterManager();
  await router.init();
  router.release();

  const registry = new PgQueueRegistry({ name: ctx.prefix, pool: ctx.pool, router });
  await registry.init();

  const checkedOut = () => ctx.pool.totalCount - ctx.pool.idleCount;
  // 300 ms for the consumers to take their clients, then until only the LISTEN connection is out,
  // or 10 s pass: a consumer that holds its client while parked holds it for good, so waiting
  // tells a leak from a slow claim however loaded the machine.
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const deadline = Date.now() + 10_000;
    while (checkedOut() > 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  };

  const consumers = 4;
  const abort = new AbortController();
  const handles = [];

  try {
    await registry.touch('parked', { routingKeys: ['parked.key'] });

    for (let i = 0; i < consumers; i++) {
      handles.push(await registry.open('parked', { routingKeys: ['parked.key'] }, 'r+'));
    }

    // Park every consumer on the empty queue, then let the claims settle.
    const reads = handles.map((handle) => handle.read(1, abort.signal));
    await settle();

    // The registry's own LISTEN connection is checked out for its lifetime; the
    // waiting consumers must account for none of the rest.
    assertEquals(checkedOut(), 1, `${consumers} parked consumers held ${checkedOut() - 1} pooled clients`);

    // And they are genuinely parked, not finished: one message each, all delivered.
    for (let i = 0; i < consumers; i++) {
      router.publish('parked.key', { n: i });
    }

    const delivered = (await Promise.all(reads)).map((bytes) => JSON.parse(dec.decode(bytes).trim()).n);
    assertEquals(delivered.toSorted(), [0, 1, 2, 3]);
  } finally {
    abort.abort();
    for (const handle of handles) {
      await handle.close();
    }
    await registry.dispose();
    await router.dispose();
    await ctx.teardown();
  }
});

/**
 * The one thing that can silently split the two backends apart.
 *
 * Patterns are compiled to a regex in TS and stored, so postgres never parses a glob — but it does
 * run the emitted source through its own regex engine. Anything JS and Postgres AREs disagree about
 * would show up as a delivery that happens in the fast tier and not in production, which no
 * conformance step covering two or three patterns would catch. So the whole table runs through
 * postgres.
 */
pgTest('the compiled pattern means the same thing to postgres as to JS', async () => {
  const ctx = pgTestContext();

  try {
    for (const [pattern, key, expected] of MATCH_CASES) {
      const res = await ctx.pool.query<{ matched: boolean }>(
        'SELECT $1::text ~ $2::text AS matched',
        [key, routingPatternToRegexSource(pattern)],
      );

      assertEquals(res.rows[0].matched, expected, `postgres: ${pattern} vs ${key} should be ${expected}`);
    }
  } finally {
    await ctx.teardown();
  }
});
