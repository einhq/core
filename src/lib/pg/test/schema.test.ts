/**
 * PG tier: a part's migrations run once each, in order, and pick up where a failed start left
 * off; a database the list cannot take further is refused. Gated by EIN_TEST_PG.
 */

import { assertEquals, assertRejects } from '@std/assert';
import type { PoolClient } from 'pg';
import { pgTest, pgTestContext } from '../../../testing/gates.ts';
import { migrate, type Migration, type SchemaPart, schemaTable } from '../schema.ts';

/** A part over `<prefix>_things`, whose migrations note in `ran` that they ran. */
const things = (prefix: string, ran: string[], count: number): SchemaPart => {
  const steps: Migration[] = [
    {
      name: 'table',
      run: async (conn) => {
        ran.push('table');
        await conn.query(`CREATE TABLE IF NOT EXISTS ${prefix}_things (id INTEGER PRIMARY KEY)`);
      },
    },
    {
      name: 'name column',
      run: async (conn) => {
        ran.push('name column');
        await conn.query(`ALTER TABLE ${prefix}_things ADD COLUMN IF NOT EXISTS name TEXT`);
      },
    },
    {
      name: 'name index',
      run: async (conn) => {
        ran.push('name index');
        await conn.query(`CREATE INDEX IF NOT EXISTS ${prefix}_things_name_idx ON ${prefix}_things (name)`);
      },
    },
  ];
  return { mount: prefix, part: 'things', table: `${prefix}_things`, migrations: steps.slice(0, count) };
};

const versionOf = async (conn: { query: PoolClient['query'] }, prefix: string): Promise<number | undefined> =>
  (await conn.query<{ version: number }>(`SELECT version FROM ${schemaTable(prefix)} WHERE part = 'things'`)).rows[0]?.version;

const columns = async (conn: { query: PoolClient['query'] }, table: string): Promise<string[]> =>
  (await conn.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  )).rows.map((row) => row.column_name);

pgTest('a part runs each migration once, in order, and only the new ones after an update', async () => {
  const ctx = pgTestContext();
  try {
    const ran: string[] = [];
    assertEquals(await migrate(ctx.pool, things(ctx.prefix, ran, 2)), 2);
    assertEquals(ran, ['table', 'name column']);
    assertEquals(await versionOf(ctx.pool, ctx.prefix), 2);

    assertEquals(await migrate(ctx.pool, things(ctx.prefix, ran, 2)), 2);
    assertEquals(ran, ['table', 'name column']);

    assertEquals(await migrate(ctx.pool, things(ctx.prefix, ran, 3)), 3);
    assertEquals(ran, ['table', 'name column', 'name index']);
  } finally {
    await ctx.teardown();
  }
});

pgTest('a migration that fails leaves the part at the one before it, and the next start goes on', async () => {
  const ctx = pgTestContext();
  try {
    const part = things(ctx.prefix, [], 3);
    const failing: SchemaPart = {
      ...part,
      migrations: [part.migrations[0], {
        name: 'fails',
        run: async (conn) => {
          await conn.query(`ALTER TABLE ${ctx.prefix}_things ADD COLUMN name TEXT`);
          throw new Error('stopped');
        },
      }],
    };
    await assertRejects(() => migrate(ctx.pool, failing), Error, 'stopped');
    assertEquals(await versionOf(ctx.pool, ctx.prefix), 1);
    // The failed migration's work went with its transaction.
    assertEquals(await columns(ctx.pool, `${ctx.prefix}_things`), ['id']);

    const ran: string[] = [];
    assertEquals(await migrate(ctx.pool, things(ctx.prefix, ran, 3)), 3);
    assertEquals(ran, ['name column', 'name index']);
  } finally {
    await ctx.teardown();
  }
});

pgTest('starts side by side migrate a part once', async () => {
  const ctx = pgTestContext();
  try {
    const ran: string[] = [];
    const versions = await Promise.all(Array.from({ length: 4 }, () => migrate(ctx.pool, things(ctx.prefix, ran, 3))));
    assertEquals(versions, [3, 3, 3, 3]);
    assertEquals(ran, ['table', 'name column', 'name index']);
  } finally {
    await ctx.teardown();
  }
});

pgTest('tables from before versions were recorded run the whole list', async () => {
  const ctx = pgTestContext();
  try {
    await ctx.pool.query(`CREATE TABLE ${ctx.prefix}_things (id INTEGER PRIMARY KEY, name TEXT)`);
    const ran: string[] = [];
    assertEquals(await migrate(ctx.pool, things(ctx.prefix, ran, 3)), 3);
    assertEquals(ran, ['table', 'name column', 'name index']);
    assertEquals(await columns(ctx.pool, `${ctx.prefix}_things`), ['id', 'name']);
  } finally {
    await ctx.teardown();
  }
});

pgTest('tables a newer EiN migrated are used as they are', async () => {
  const ctx = pgTestContext();
  try {
    await migrate(ctx.pool, things(ctx.prefix, [], 3));
    const ran: string[] = [];
    assertEquals(await migrate(ctx.pool, things(ctx.prefix, ran, 2)), 3);
    assertEquals(ran, []);
    assertEquals(await versionOf(ctx.pool, ctx.prefix), 3);
  } finally {
    await ctx.teardown();
  }
});

pgTest('with the first migrations deleted, a new database gets the baseline and an old one is refused', async () => {
  const ctx = pgTestContext();
  try {
    const ran: string[] = [];
    const full = things(ctx.prefix, ran, 3);
    // Migrations 1 and 2 deleted: the baseline makes what they made.
    const floored = (mount: string): SchemaPart => {
      const part = things(mount, ran, 3);
      return {
        ...part,
        migrations: part.migrations.slice(2),
        floor: {
          version: 2,
          release: '0.4.0',
          baseline: {
            name: 'baseline',
            run: async (conn) => {
              ran.push('baseline');
              await conn.query(`CREATE TABLE ${mount}_things (id INTEGER PRIMARY KEY, name TEXT)`);
            },
          },
        },
      };
    };

    // New: the baseline, then what follows it.
    const fresh = `${ctx.prefix}_new`;
    assertEquals(await migrate(ctx.pool, floored(fresh)), 3);
    assertEquals(ran, ['baseline', 'name index']);
    assertEquals(await columns(ctx.pool, `${fresh}_things`), ['id', 'name']);

    // At the floor: what follows it.
    ran.length = 0;
    await migrate(ctx.pool, { ...full, migrations: full.migrations.slice(0, 2) });
    ran.length = 0;
    assertEquals(await migrate(ctx.pool, floored(ctx.prefix)), 3);
    assertEquals(ran, ['name index']);

    // Below it, or from before versions were recorded: refused, naming the release to go through.
    const below = `${ctx.prefix}_old`;
    await migrate(ctx.pool, { ...things(below, [], 1) });
    await assertRejects(
      () => migrate(ctx.pool, floored(below)),
      Error,
      `the things tables of ${below} are at schema version 1, which this EiN no longer updates from: update through EiN 0.4.0 first`,
    );
    const unversioned = `${ctx.prefix}_none`;
    await ctx.pool.query(`CREATE TABLE ${unversioned}_things (id INTEGER PRIMARY KEY)`);
    await assertRejects(
      () => migrate(ctx.pool, floored(unversioned)),
      Error,
      `the things tables of ${unversioned} have no recorded schema version: update through EiN 0.4.0 first`,
    );
  } finally {
    await ctx.teardown();
  }
});
