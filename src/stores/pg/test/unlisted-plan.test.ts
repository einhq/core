/**
 * PG tier: what leaving an unlisted tree out of a library view costs the plan. The unlisted
 * directories are found off the `unlisted` index; an aggregate that leaves a tree out stays one
 * parallel scan, with a hash anti-join on the edges under the tree's directories, which an init
 * plan collects once, read off a parent index; a feed batch reads the time index, and its walk up
 * the hierarchy reads it by child. Each holds as a generic plan too, which a prepared statement may be given whatever
 * its values. The answers leave the tree out. Gated by EIN_TEST_PG.
 */

import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import type { Pool, PoolClient } from 'pg';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import type { IndexDecl } from '../../../lib/contributions/types.ts';
import { NOT_DERIVED } from '../../../lib/kinds/mod.ts';
import { UNLISTED_ATTR, unlistedRoots } from '../../../lib/search/unlisted.ts';
import { RouterManager } from '../../../managers/router/mod.ts';
import { MemoryFileRegistry } from '../../../registries/file/mod.ts';
import { repoModules } from '../../../modules/repo.ts';
import { pgTest, pgTestContext } from '../../../testing/gates.ts';
import { LocalNodeVFS, type NodeVFS, type StoreAggregateQuery } from '../../../vfs/mod.ts';
import { PgStore } from '../index.ts';
import { buildAggregateSql, buildQuerySql, buildUpwalkSql, type SqlQuery } from '../query.ts';

const LIBRARY_DIRS = 40;
const PER_DIR = 50;
const STAGED = 300;
const STAGING = '/home/anna/staging';

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

const dated = (i: number) => {
  const at = new Date(Date.UTC(2000, 0, 1) + i * 86_400_000 * 3).toISOString().slice(0, 19);
  return { mimetype: 'image/jpeg', takenAt: at, takenAtUtc: `${at}Z` };
};

/** A library of dated pictures in many folders, and a staging area of more, every day between them. */
async function seed(vfs: NodeVFS): Promise<void> {
  for (const path of ['/library', '/home', '/home/anna', STAGING, `${STAGING}/files`, `${STAGING}/files/inbox`]) {
    const at = path.lastIndexOf('/');
    await vfs.create(ADMIN_ACCESS, 'directory', path.slice(0, at) || '/', path.slice(at + 1), { props: { mode: 0o755 } });
  }
  for (let d = 0; d < LIBRARY_DIRS; d++) {
    await vfs.createTree(ADMIN_ACCESS, '/library', [{
      type: 'directory',
      name: `d${d}`,
      props: { mode: 0o755 },
      children: Array.from({ length: PER_DIR }, (_, k) => ({ type: 'file', name: `f${k}.jpg`, attrs: dated(2 * (d * PER_DIR + k)) })),
    }]);
  }
  await vfs.createTree(ADMIN_ACCESS, `${STAGING}/files/inbox`, [{
    type: 'directory',
    name: 'upload',
    props: { mode: 0o755 },
    children: Array.from({ length: STAGED }, (_, k) => ({ type: 'file', name: `s${k}.jpg`, attrs: dated(2 * k + 1) })),
  }]);
  await vfs.update(ADMIN_ACCESS, STAGING, { attrs: { [UNLISTED_ATTR]: true } });
}

/** Whether the first plan line matching `node` has a `Gather` above it. */
const underGather = (plan: string, node: RegExp): boolean => {
  const lines = plan.split('\n');
  const at = lines.findIndex((line) => node.test(line));
  if (at < 0) return false;
  const indent = (line: string) => line.length - line.trimStart().length;
  let depth = indent(lines[at]);
  for (let i = at - 1; i >= 0; i--) {
    if (indent(lines[i]) >= depth) continue;
    depth = indent(lines[i]);
    if (/Gather/.test(lines[i])) return true;
  }
  return false;
};

/** The plan of `sql`: as planned for its values, or the generic plan a prepared statement may be given whatever they are. */
const planOf = async (client: PoolClient, sql: SqlQuery, generic: boolean): Promise<string> => {
  const explained = generic
    ? await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (GENERIC_PLAN) ${sql.text}`)
    : await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql.text}`, sql.values);
  return explained.rows.map((r) => r['QUERY PLAN']).join('\n');
};

pgTest('leaving an unlisted tree out keeps library views on their indexes', async (t) => {
  const ctx = pgTestContext();
  const { vfs, dispose } = await createPgVfs(ctx.pool, ctx.prefix);
  const nodesTable = `${ctx.prefix}_nodes`;
  const attrsTable = `${nodesTable}_attr`;
  const hierarchyTable = `${nodesTable}_lnk`;
  const tables = { nodes: nodesTable, hierarchy: hierarchyTable };

  try {
    await t.step('seed a library and a staging area beside it', async () => {
      await seed(vfs);
      for (const table of [nodesTable, attrsTable, hierarchyTable]) await ctx.pool.query(`ANALYZE ${table}`);
    });
    const staging = (await vfs.get(ADMIN_ACCESS, STAGING)).id;

    await t.step('the unlisted directories are read off the unlisted index', async () => {
      const sql = buildQuerySql({ types: ['directory'], where: [{ ref: UNLISTED_ATTR, op: 'eq', value: true }], limit: 1000 }, nodesTable, attrsTable);
      const client = await ctx.pool.connect();
      try {
        for (const generic of [false, true]) {
          const plan = await planOf(client, sql, generic);
          assert(new RegExp(`Index[^\\n]*${attrsTable}_unlisted_idx`).test(plan), `${generic ? 'generic: ' : ''}${plan}`);
        }
      } finally {
        client.release();
      }
      assertEquals(await unlistedRoots(vfs), [STAGING]);
    });

    await t.step('an aggregate leaving the tree out stays one parallel scan with a hash anti-join', async () => {
      const client = await ctx.pool.connect();
      try {
        // Parallel at any size, as it is over a real archive.
        await client.query('SET parallel_setup_cost = 0');
        await client.query('SET parallel_tuple_cost = 0');
        await client.query('SET min_parallel_table_scan_size = 0');
        await client.query('SET min_parallel_index_scan_size = 0');
        for (const group of [[{ column: 'type' }], [{ ref: 'takenAt', prefixLength: 10 }]] as StoreAggregateQuery['group'][]) {
          const sql = buildAggregateSql({ where: [NOT_DERIVED], group, notWithinIds: [staging] }, nodesTable, attrsTable, hierarchyTable);
          for (const generic of [false, true]) {
            const plan = await planOf(client, sql, generic);
            const label = `${JSON.stringify(group)}${generic ? ' (generic)' : ''}`;
            // An index-only scan, chosen once the visibility map is set, prints the column without its cast.
            assert(
              /Index Cond: \((\(parent_id\)::text|parent_id) = ANY \(\(\(InitPlan \d+\)/.test(plan),
              `${label}: the edges are not read under the init plan's directories:\n${plan}`,
            );
            assert(new RegExp(`Index[^\\n]*${hierarchyTable}_parent_\\w+_idx`).test(plan), `${label}: the edges are not read off a parent index:\n${plan}`);
            assert(underGather(plan, /Hash (Right )?Anti Join/), `${label}: the anti-join is not a parallel hash join:\n${plan}`);
          }
        }
      } finally {
        await client.query('RESET ALL').catch(() => {});
        client.release();
      }
    });

    await t.step('a feed batch reads the time index, and its walk up the hierarchy by child', async () => {
      const ids = (await vfs.query(ADMIN_ACCESS, { where: [NOT_DERIVED], orderBy: { ref: 'takenAtUtc', dir: 'desc' }, limit: 120 })).map((row) => row.id);
      const reads: [string, SqlQuery, string][] = [
        [
          'a feed batch',
          buildQuerySql({ where: [NOT_DERIVED], orderBy: { ref: 'takenAtUtc', dir: 'desc' }, limit: 120 }, nodesTable, attrsTable, hierarchyTable),
          `${attrsTable}_taken_utc_idx`,
        ],
        ['its walk up', buildUpwalkSql(ids, [staging], [staging], tables), `${hierarchyTable}_child_idx`],
      ];
      const client = await ctx.pool.connect();
      try {
        for (const [name, sql, index] of reads) {
          for (const generic of [false, true]) {
            const plan = await planOf(client, sql, generic);
            const label = `${name}${generic ? ' (generic)' : ''}`;
            assert(new RegExp(`Index[^\\n]*${index}`).test(plan), `${label}: expected ${index}, got:\n${plan}`);
            assert(!plan.includes(`Seq Scan on ${attrsTable}`) && !plan.includes(`Seq Scan on ${hierarchyTable}`), `${label}: a table was seq scanned:\n${plan}`);
          }
        }
      } finally {
        client.release();
      }
    });

    await t.step('the answers leave the tree out', async () => {
      const notWithin = [...await unlistedRoots(vfs)];
      const page = await vfs.query(ADMIN_ACCESS, { types: ['file'], where: [NOT_DERIVED], notWithin, orderBy: { ref: 'takenAtUtc', dir: 'desc' }, limit: 200 });
      assertEquals(page.length, 200);
      assert(page.every((row) => row.absPath.startsWith('/library/')), 'a staged file in the feed');
      const values = page.map((row) => row.sortValue!);
      assertEquals(values, [...values].sort().reverse());
      const counts = await vfs.aggregate(ADMIN_ACCESS, { types: ['file'], where: [NOT_DERIVED], notWithin, group: [{ column: 'type' }] });
      assertEquals(counts.map((bucket) => [bucket.key[0], bucket.count]), [['file', LIBRARY_DIRS * PER_DIR]]);
      const days = await vfs.aggregate(ADMIN_ACCESS, { where: [NOT_DERIVED], notWithin, group: [{ ref: 'takenAt', prefixLength: 10 }] });
      assertEquals(days.reduce((sum, bucket) => sum + bucket.count, 0), LIBRARY_DIRS * PER_DIR);
    });
  } finally {
    await dispose();
    await ctx.teardown();
  }
});
