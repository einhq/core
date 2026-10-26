import { assertEquals, assertNotEquals } from '@std/assert';
import { PG_URL, pgTest, pgTestContext } from '../../../testing/gates.ts';
import { PgPoolRegistry } from '../pg-pool-registry.ts';
import { poolConformanceTests } from './pool-conformance.ts';

poolConformanceTests('PgPoolRegistry conformance', async () => {
  const ctx = pgTestContext();
  const registry = new PgPoolRegistry({ pool: ctx.pool, name: ctx.prefix });
  await registry.init();

  return {
    registry,
    teardown: async () => {
      await registry.dispose();
      await ctx.teardown();
    },
  };
  // A blocking claim only notices a time-based change on its poll tick.
}, { ignore: !PG_URL, sanitize: false, wakeMs: 1200 });

pgTest('PgPoolRegistry durability across re-instantiation', async () => {
  const ctx = pgTestContext();

  try {
    const first = new PgPoolRegistry({ pool: ctx.pool, name: ctx.prefix });
    await first.init();
    await first.touch('durable', { agingSeconds: 42 });
    const job = await first.add('durable', { kind: 'a', priority: 7, dedupKey: 'k', requires: { cpu: 2 } });
    await first.dispose();

    const second = new PgPoolRegistry({ pool: ctx.pool, name: ctx.prefix });
    await second.init();

    const stat = await second.stat('durable');
    assertEquals(stat.agingSeconds, 42);
    assertEquals(stat.size, 1);

    const reloaded = await second.get('durable', job.id);
    assertEquals(reloaded?.priority, 7);
    assertEquals(reloaded?.requires, { cpu: 2 });
    assertEquals(reloaded?.dedupKey, 'k');

    // The dedup index survives too, so a restart cannot duplicate the job.
    assertEquals((await second.add('durable', { kind: 'a', dedupKey: 'k' })).id, job.id);
    assertEquals((await second.counts('durable')).total, 1);

    await second.dispose();
  } finally {
    await ctx.teardown();
  }
});

// A crawl announces one subject from several connections at once. The add that loses the race
// on the dedup key resolves to the job the winner wrote, not to "no pool found" (ein/core#739).
pgTest('PgPoolRegistry resolves concurrent adds of one dedup key to one job', async () => {
  const ctx = pgTestContext();
  const registry = new PgPoolRegistry({ pool: ctx.pool, name: ctx.prefix });

  try {
    await registry.init();
    await registry.touch('race', {});
    for (let round = 0; round < 20; round++) {
      const jobs = await Promise.all(
        Array.from({ length: 8 }, () => registry.add('race', { kind: 'a', dedupKey: `subject-${round}` })),
      );
      assertEquals(new Set(jobs.map((job) => job.id)).size, 1);
    }
    assertEquals((await registry.counts('race')).total, 20);
  } finally {
    await registry.dispose();
    await ctx.teardown();
  }
});

pgTest('PgPoolRegistry purges a backlog in batches and banks every one', async () => {
  const ctx = pgTestContext();
  const registry = new PgPoolRegistry({ pool: ctx.pool, name: ctx.prefix });

  try {
    await registry.init();
    await registry.touch('backlog', {});

    // More than two batches of old jobs, seeded directly: adding them one by one is minutes.
    await ctx.pool.query(
      `INSERT INTO ${ctx.prefix}_pools_job (pool_id, kind, state, finished_at)
       SELECT 'backlog', CASE WHEN i % 3 = 0 THEN 'b' ELSE 'a' END, 'done', now() - interval '2 days'
         FROM generate_series(1, 12000) AS i`,
    );
    // Recent ones the age limit keeps, interleaved by id with the old ones.
    await ctx.pool.query(
      `INSERT INTO ${ctx.prefix}_pools_job (pool_id, kind, state, finished_at)
       SELECT 'backlog', 'a', 'done', now() FROM generate_series(1, 10)`,
    );

    const before = await registry.stat('backlog');
    assertEquals(await registry.purge('backlog', { olderThanMs: 24 * 3600_000 }), 12000);
    const after = await registry.stat('backlog');

    assertEquals(after.counts, before.counts);
    assertEquals(after.byKind.a.done, 8010);
    assertEquals(after.byKind.b.done, 4000);
    assertEquals((await registry.jobs('backlog')).length, 10);
  } finally {
    await registry.dispose();
    await ctx.teardown();
  }
});

pgTest('PgPoolRegistry re-adding a waiting job with nothing new writes nothing', async () => {
  const ctx = pgTestContext();
  const registry = new PgPoolRegistry({ pool: ctx.pool, name: ctx.prefix });
  // The row version: a write of any kind, even one that changes no value, makes a new one.
  const version = async (id: string) => (await ctx.pool.query<{ xmin: string }>(`SELECT xmin::text FROM ${ctx.prefix}_pools_job WHERE id = $1`, [id])).rows[0]?.xmin;

  try {
    await registry.init();
    await registry.touch('readd', {});
    const job = await registry.add('readd', { kind: 'a', priority: 5, dedupKey: 'k' });
    const written = await version(String(job.id));

    // A crawl re-announcing the same waiting work: same job back, row untouched.
    const again = await registry.add('readd', { kind: 'a', priority: 5, dedupKey: 'k' });
    assertEquals(again.id, job.id);
    assertEquals(again.priority, 5);
    assertEquals(await version(String(job.id)), written);
    const lower = await registry.add('readd', { kind: 'a', priority: 1, dedupKey: 'k' });
    assertEquals(lower.priority, 5);
    assertEquals(await version(String(job.id)), written);

    // A higher priority is news, and is written.
    const raised = await registry.add('readd', { kind: 'a', priority: 9, dedupKey: 'k' });
    assertEquals(raised.id, job.id);
    assertEquals(raised.priority, 9);
    assertNotEquals(await version(String(job.id)), written);
    assertEquals((await registry.jobs('readd')).length, 1);
  } finally {
    await registry.dispose();
    await ctx.teardown();
  }
});
