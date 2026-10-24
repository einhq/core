/**
 * PG tier: what `search --missing` costs the plan of a staging listing (`search --within <inbox>
 * --missing duplicate.deferred`, the Files tab). The condition is a filter on the attrs row each
 * plan already reads, and with the statistics archive declares on the attr (`duplicate_deferred`)
 * it changes how no plan reads a table: a small subtree reads its materialized members and their
 * attrs rows by key, a large one the time index a batch at a time and the undated after in id
 * order, and the counts read the members too. Each holds as a generic plan as well, which a
 * prepared statement may be given whatever its values. The answers leave the copies out. Gated by
 * EIN_TEST_PG.
 */

import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import type { Pool, PoolClient } from 'pg';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import type { IndexDecl } from '../../../lib/contributions/types.ts';
import { NOT_DERIVED } from '../../../lib/kinds/mod.ts';
import { RouterManager } from '../../../managers/router/mod.ts';
import { MemoryFileRegistry } from '../../../registries/file/mod.ts';
import { repoModules } from '../../../modules/repo.ts';
import { pgTest, pgTestContext } from '../../../testing/gates.ts';
import { type AttrCondition, attrRefOf, LocalNodeVFS, type NodeVFS } from '../../../vfs/mod.ts';
import { PgStore } from '../index.ts';
import { buildAggregateSql, buildQuerySql, type SqlQuery } from '../query.ts';

const LIBRARY_DIRS = 400;
const STAGED_DIRS = 20;
const PER_DIR = 100;
/** Every fourth staged file is a deferred copy. */
const DEFERRED_EVERY = 4;
const INBOX = '/home/anna/staging/files/inbox';

const MISSING_DEFERRED: AttrCondition = { ref: attrRefOf('duplicate.deferred'), op: 'missing' };

/** Every index the repository's modules declare, as `mod setup` would create them. */
async function declaredIndexes(): Promise<IndexDecl[]> {
  const indexes: IndexDecl[] = [];
  for (const { dir } of repoModules()) {
    try {
      const manifest = JSON.parse(await Deno.readTextFile(join(dir, 'mod.json'))) as { indexes?: IndexDecl[] };
      indexes.push(...manifest.indexes ?? []);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound || error instanceof Deno.errors.NotADirectory)) throw error;
    }
  }
  return indexes;
}

async function createPgVfs(pool: Pool, name: string) {
  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();
  const vfs = new LocalNodeVFS(new PgStore({ pgPool: pool, name }), routerManager, { file: new MemoryFileRegistry() });
  await vfs.initialize();
  await vfs.ensureAttrIndexes(ADMIN_ACCESS, await declaredIndexes());
  return {
    vfs,
    dispose: async () => {
      await vfs.dispose();
      await routerManager.dispose();
    },
  };
}

/** A picture taken on day `i`, undated when `i` is a multiple of 7, a deferred copy when `deferred`. */
const picture = (i: number, deferred: boolean) => {
  const at = new Date(Date.UTC(2000, 0, 1) + i * 86_400_000).toISOString().slice(0, 19);
  return {
    mimetype: 'image/jpeg',
    size: 100,
    ...(i % 7 === 0 ? {} : { takenAt: at, takenAtUtc: `${at}Z` }),
    ...(deferred ? { duplicate: { inbox: 'anna', sha256: `s${i}`, at: '2026-10-01T00:00:00Z', kind: 'exact', where: 'inbox', of: 'x', deferred: true } } : {}),
  };
};

/** A library of dated pictures, and an inbox of more, some of them deferred copies. */
async function seed(vfs: NodeVFS): Promise<void> {
  for (const path of ['/library', '/home', '/home/anna', '/home/anna/staging', '/home/anna/staging/files', INBOX]) {
    const at = path.lastIndexOf('/');
    await vfs.create(ADMIN_ACCESS, 'directory', path.slice(0, at) || '/', path.slice(at + 1), { props: { mode: 0o755 } });
  }
  for (let d = 0; d < LIBRARY_DIRS; d++) {
    await vfs.createTree(ADMIN_ACCESS, '/library', [{
      type: 'directory',
      name: `d${d}`,
      props: { mode: 0o755 },
      children: Array.from({ length: PER_DIR }, (_, k) => ({ type: 'file', name: `f${k}.jpg`, attrs: picture(d * PER_DIR + k, false) })),
    }]);
  }
  for (let d = 0; d < STAGED_DIRS; d++) {
    await vfs.createTree(ADMIN_ACCESS, INBOX, [{
      type: 'directory',
      name: `upload-${d}`,
      props: { mode: 0o755 },
      children: Array.from({ length: PER_DIR }, (_, k) => ({ type: 'file', name: `s${k}.jpg`, attrs: picture(d * PER_DIR + k, k % DEFERRED_EVERY === 0) })),
    }]);
  }
}

/** The plan of `sql`: as planned for its values, or the generic plan a prepared statement may be given whatever they are. */
const planOf = async (client: PoolClient, sql: SqlQuery, generic: boolean): Promise<string> => {
  const explained = generic
    ? await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (GENERIC_PLAN) ${sql.text}`)
    : await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql.text}`, sql.values);
  return explained.rows.map((r) => r['QUERY PLAN']).join('\n');
};

/** How the plan reads each table: every scan, its index and its relation, in order. */
const scans = (plan: string): string[] =>
  [...plan.matchAll(/((?:Parallel )?(?:Seq Scan|Index Only Scan|Index Scan|Bitmap Heap Scan|Bitmap Index Scan|CTE Scan)(?: Backward)?(?: using \S+)? on \S+)/g)]
    .map((match) => match[1].replace(/t\w+?_nodes/g, 'nodes'));

pgTest('a staging listing that leaves deferred copies out keeps its plans', async (t) => {
  const ctx = pgTestContext();
  const { vfs, dispose } = await createPgVfs(ctx.pool, ctx.prefix);
  const nodesTable = `${ctx.prefix}_nodes`;
  const attrsTable = `${nodesTable}_attr`;
  const hierarchyTable = `${nodesTable}_lnk`;

  try {
    await t.step('seed a library and an inbox with deferred copies in it', async () => {
      await seed(vfs);
      for (const table of [nodesTable, attrsTable, hierarchyTable]) await ctx.pool.query(`ANALYZE ${table}`);
    });
    const inbox = (await vfs.get(ADMIN_ACCESS, INBOX)).id;
    const undated: AttrCondition = { ref: 'takenAtUtc', op: 'missing' };
    const ordered = { ref: 'takenAtUtc', dir: 'desc' as const };
    /** The reads of one Files tab listing, with or without the condition. */
    const reads = (extra: AttrCondition[]): [string, SqlQuery][] => {
      const where = [NOT_DERIVED, ...extra];
      return [
        ['a small subtree, by time', buildQuerySql({ withinId: inbox, types: ['file'], where, orderBy: ordered, limit: 60 }, nodesTable, attrsTable, hierarchyTable)],
        ['a small subtree, the undated', buildQuerySql({ withinId: inbox, types: ['file'], where: [...where, undated], limit: 60 }, nodesTable, attrsTable, hierarchyTable)],
        ['a large subtree, a batch by time', buildQuerySql({ types: ['file'], where, orderBy: ordered, limit: 128 }, nodesTable, attrsTable, hierarchyTable)],
        ['a large subtree, a batch of the undated', buildQuerySql({ types: ['file'], where: [...where, undated], limit: 128 }, nodesTable, attrsTable, hierarchyTable)],
        [
          'its counts',
          buildAggregateSql({ withinId: inbox, types: ['file'], where, group: [{ ref: 'takenAt', prefixLength: 10 }] }, nodesTable, attrsTable, hierarchyTable),
        ],
      ];
    };

    await t.step('the condition changes how no plan reads a table, as planned for the values or as a generic plan', async () => {
      const client = await ctx.pool.connect();
      try {
        const without = reads([]);
        const withMissing = reads([MISSING_DEFERRED]);
        for (let i = 0; i < without.length; i++) {
          for (const generic of [false, true]) {
            const label = `${without[i][0]}${generic ? ' (generic)' : ''}`;
            const plan = await planOf(client, withMissing[i][1], generic);
            assertEquals(scans(plan), scans(await planOf(client, without[i][1], generic)), `${label}:\n${plan}`);
            assert(plan.includes(`'duplicate'::text) ->> 'deferred'::text) IS NULL`), `${label}: the condition is not a filter:\n${plan}`);
          }
        }
      } finally {
        client.release();
      }
    });

    await t.step('a small subtree reads the attrs rows of its members by key, a large one the time index', async () => {
      const client = await ctx.pool.connect();
      try {
        const [byTime, undatedPage, batch, undatedBatch] = reads([MISSING_DEFERRED]);
        const p1 = await planOf(client, byTime[1], false);
        assert(p1.includes('CTE within_members') && new RegExp(`Index Scan using ${attrsTable}_pkey`).test(p1), p1);
        assert(!p1.includes(`Seq Scan on ${attrsTable}`), p1);
        assert(!(await planOf(client, undatedPage[1], false)).includes(`Seq Scan on ${attrsTable}`));
        for (const generic of [false, true]) {
          const p2 = await planOf(client, batch[1], generic);
          assert(new RegExp(`Index Scan Backward using ${attrsTable}_taken_utc_idx`).test(p2), p2);
          const tail = await planOf(client, undatedBatch[1], generic);
          assert(!tail.includes(`Seq Scan on ${attrsTable}`), tail);
        }
      } finally {
        client.release();
      }
    });

    await t.step('the answers leave the deferred copies out', async () => {
      const staged = STAGED_DIRS * PER_DIR;
      const kept = staged - staged / DEFERRED_EVERY;
      const rows = [];
      let after: { value: string | null; id: string } | undefined;
      for (;;) {
        const page = await vfs.query(ADMIN_ACCESS, { within: INBOX, types: ['file'], where: [NOT_DERIVED, MISSING_DEFERRED], ...(after ? { after } : {}), limit: 1000 });
        rows.push(...page);
        if (page.length < 1000) break;
        after = { value: null, id: page[page.length - 1].id };
      }
      assertEquals(rows.length, kept);
      assert(rows.every((row) => (row.node.attrs as { duplicate?: unknown }).duplicate === undefined));
      const counts = await vfs.aggregate(ADMIN_ACCESS, { within: INBOX, types: ['file'], where: [NOT_DERIVED, MISSING_DEFERRED], group: [{ column: 'type' }] });
      assertEquals(counts.map((bucket) => bucket.count), [kept]);
    });
  } finally {
    await dispose();
    await ctx.teardown();
  }
});
