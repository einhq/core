/**
 * PG tier: log conformance against PostgreSQL/TimescaleDB.
 * Gated by EIN_TEST_PG.
 */

import { assert } from '@std/assert';
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
    await registry.touch('slow', { retention: 'forever' });
    await registry.touch('fast', { retention: 'forever' });

    await blocker.query('BEGIN');
    await blocker.query(`LOCK TABLE ${ctx.prefix}_logs_slow IN ACCESS EXCLUSIVE MODE`);

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

pgTest('PgLogRegistry follows a log whose table name passes the identifier limit', async () => {
  const ctx = pgTestContext();
  const router = new RouterManager();
  await router.init();
  router.release();

  // A long prefix and a ULID log id make a table name past 63 bytes, which PostgreSQL truncates.
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
