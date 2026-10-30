/**
 * PG tier: log conformance against PostgreSQL/TimescaleDB.
 * Gated by EIN_TEST_PG.
 */

import { assert, assertEquals } from '@std/assert';
import { LogHandle } from '../log-handle.ts';
import { RouterManager } from '../../../managers/router/mod.ts';
import { PG_URL, pgTest, pgTestContext } from '../../../testing/gates.ts';
import { PgLogRegistry } from '../mod.ts';
import { logConformanceTests } from './log-conformance.ts';

logConformanceTests('PgLogRegistry conformance', async () => {
  const ctx = pgTestContext();
  const router = new RouterManager();
  await router.init();
  router.release();

  const registry = new PgLogRegistry({ name: ctx.prefix, pool: ctx.pool, router });
  await registry.init();

  return {
    registry,
    router,
    teardown: async () => {
      await registry.dispose();
      await router.dispose();
      await ctx.teardown();
    },
  };
}, { ignore: !PG_URL, sanitize: false });

pgTest('PgLogRegistry does not serialize unrelated logs', async () => {
  const ctx = pgTestContext();
  const router = new RouterManager();
  await router.init();
  router.release();

  const registry = new PgLogRegistry({ name: ctx.prefix, pool: ctx.pool, router });
  await registry.init();

  const blocker = await ctx.pool.connect();
  try {
    // Different retentions, so the two logs' entries are in different tables.
    await registry.touch('slow', { retention: '7 day' });
    await registry.touch('fast', { retention: 'forever' });

    await blocker.query('BEGIN');
    await blocker.query(`LOCK TABLE ${ctx.prefix}_logs_e_d604800 IN ACCESS EXCLUSIVE MODE`);

    // This stat reaches the slow log's COUNT and waits on the table lock.
    const slow = registry.stat('slow');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const fast = registry.stat('fast');
    const fastFinished = await Promise.race([
      fast.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);
    assert(fastFinished, 'an unrelated log query was serialized behind the blocked log');

    await blocker.query('COMMIT');
    await slow;
  } finally {
    try {
      await blocker.query('ROLLBACK');
    } catch {
      // The transaction was already committed or the connection is gone.
    }
    blocker.release();
    await registry.dispose();
    await router.dispose();
    await ctx.teardown();
  }
});

pgTest('PgLogRegistry follows a ULID-named log under a long registry name', async () => {
  const ctx = pgTestContext();
  const router = new RouterManager();
  await router.init();
  router.release();

  // A long prefix and a ULID log id, as a root mount's logs have.
  const registry = new PgLogRegistry({ name: `${ctx.prefix}_root`, pool: ctx.pool, router });
  await registry.init();

  const id = '01JZ8Q3V7M2K4T6W9X0Y1A2B3C';
  try {
    await registry.touch(id, { retention: 'forever' });
    const tail = await registry.open(id, {}, 'a+');
    const writer = await registry.open(id, {}, 'a');
    try {
      const ac = new AbortController();
      const pending = tail.read(10, ac.signal);
      await writer.write(new TextEncoder().encode(JSON.stringify({ seq: 1 }) + '\n'));
      const timer = setTimeout(() => ac.abort(), 2000);
      const read = await pending;
      clearTimeout(timer);
      assert(read.length > 0, 'the blocking read was not woken by the append');
    } finally {
      await tail.close();
      await writer.close();
    }
  } finally {
    await registry.dispose();
    await router.dispose();
    await ctx.teardown();
  }
});

async function pgLogSetup() {
  const ctx = pgTestContext();
  const router = new RouterManager();
  await router.init();
  router.release();

  const registry = new PgLogRegistry({ name: ctx.prefix, pool: ctx.pool, router });
  await registry.init();

  return {
    ctx,
    registry,
    teardown: async () => {
      await registry.dispose();
      await router.dispose();
      await ctx.teardown();
    },
  };
}

async function append(registry: PgLogRegistry, id: string, values: number[], createdAt?: Date) {
  const writer = await registry.open(id, {}, 'a') as LogHandle;
  try {
    for (const v of values) await writer.appendAt({ v }, createdAt);
  } finally {
    await writer.close();
  }
}

async function values(registry: PgLogRegistry, id: string): Promise<number[]> {
  const reader = await registry.open(id, {}, 'r') as LogHandle;
  try {
    return (await reader.readEntries(100)).map((e) => (e.data as { v: number }).v);
  } finally {
    await reader.close();
  }
}

pgTest('PgLogRegistry keeps logs of one retention in one table', async () => {
  const { ctx, registry, teardown } = await pgLogSetup();
  try {
    await registry.touch('a', { retention: 'forever' });
    await registry.touch('b', { retention: 'forever' });
    await registry.touch('c', { retention: '30 day' });
    await append(registry, 'a', [1, 2]);
    await append(registry, 'b', [3]);
    await append(registry, 'a', [4]);

    assertEquals(await values(registry, 'a'), [1, 2, 4]);
    assertEquals(await values(registry, 'b'), [3]);

    const tables = await ctx.pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE $1 ORDER BY 1`,
      [`${ctx.prefix}_logs%`],
    );
    assertEquals(tables.rows.map((r) => r.tablename.slice(ctx.prefix.length)), ['_logs', '_logs_e_d2592000', '_logs_e_forever']);
  } finally {
    await teardown();
  }
});

pgTest("PgLogRegistry moves a log's entries when its retention changes", async () => {
  const { registry, teardown } = await pgLogSetup();
  try {
    await registry.touch('moving', { retention: 'forever' });
    await append(registry, 'moving', [1, 2, 3]);

    assertEquals(await registry.touch('moving', { retention: '7 day' }), true);
    assertEquals(await values(registry, 'moving'), [1, 2, 3]);
    assertEquals(await registry.touch('moving', { retention: '7 day' }), false);

    assertEquals(await registry.touch('moving', { retention: '2 entries' }), true);
    assertEquals(await values(registry, 'moving'), [2, 3]);
    assertEquals((await registry.stat('moving')).retention, '2 entries');
  } finally {
    await teardown();
  }
});

pgTest('PgLogRegistry appends to, truncates and deletes a log in compressed chunks', async () => {
  const { ctx, registry, teardown } = await pgLogSetup();
  try {
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    await registry.touch('kept', { retention: 'forever' });
    await registry.touch('gone', { retention: 'forever' });
    await append(registry, 'kept', [1, 2], old);
    await append(registry, 'gone', [3, 4], old);

    const compressed = await ctx.pool.query<{ n: string }>(
      `SELECT count(compress_chunk(c)) AS n FROM show_chunks('${ctx.prefix}_logs_e_forever') c`,
    );
    assert(Number(compressed.rows[0].n) > 0, 'no chunk was compressed');

    await append(registry, 'kept', [5], old);
    await append(registry, 'kept', [6]);
    assertEquals(await values(registry, 'kept'), [1, 2, 5, 6]);

    assertEquals(await registry.delete('gone'), true);
    assertEquals(await registry.exists('gone'), false);
    assertEquals(await values(registry, 'kept'), [1, 2, 5, 6]);

    const truncator = await registry.open('kept', {}, 'w');
    await truncator.close();
    assertEquals((await registry.stat('kept')).size, 0);
  } finally {
    await teardown();
  }
});
