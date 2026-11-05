/**
 * PG tier: the directories that say which processing they want are read off core's `processing`
 * index, as planned for its values and as a generic plan, among a library of thousands of nodes
 * that carry no such attr; the lookup reads a list and a single name, nearest first. Gated by
 * EIN_TEST_PG.
 */

import { assert, assertEquals } from '@std/assert';
import type { Pool, PoolClient } from 'pg';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { PROCESSING_ATTR, processingRoots } from '../../../lib/processing.ts';
import { RouterManager } from '../../../managers/router/mod.ts';
import { MemoryFileRegistry } from '../../../registries/file/mod.ts';
import { pgTest, pgTestContext } from '../../../testing/gates.ts';
import { LocalNodeVFS } from '../../../vfs/mod.ts';
import { PgStore } from '../index.ts';
import { buildQuerySql, type SqlQuery } from '../query.ts';

const LIBRARY_DIRS = 40;
const PER_DIR = 50;

async function createPgVfs(pool: Pool, name: string) {
  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();
  const vfs = new LocalNodeVFS(new PgStore({ pgPool: pool, name }), routerManager, { file: new MemoryFileRegistry() });
  await vfs.initialize();
  return {
    vfs,
    dispose: async () => {
      await vfs.dispose();
      await routerManager.dispose();
    },
  };
}

/** The plan of `sql`: as planned for its values, or the generic plan a prepared statement may be given whatever they are. */
const planOf = async (client: PoolClient, sql: SqlQuery, generic: boolean): Promise<string> => {
  const explained = generic
    ? await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (GENERIC_PLAN) ${sql.text}`)
    : await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql.text}`, sql.values);
  return explained.rows.map((r) => r['QUERY PLAN']).join('\n');
};

pgTest('the folders that say which processing they want are read off their index', async (t) => {
  const ctx = pgTestContext();
  const { vfs, dispose } = await createPgVfs(ctx.pool, ctx.prefix);
  const nodesTable = `${ctx.prefix}_nodes`;
  const attrsTable = `${nodesTable}_attr`;

  try {
    await t.step('seed a library, and two folders that say what they want', async () => {
      for (const [parent, name] of [['/', 'library'], ['/', 'recipes'], ['/recipes', 'soups']]) {
        await vfs.create(ADMIN_ACCESS, 'directory', parent, name, { props: { mode: 0o755 } });
      }
      for (let d = 0; d < LIBRARY_DIRS; d++) {
        await vfs.createTree(ADMIN_ACCESS, '/library', [{
          type: 'directory',
          name: `d${d}`,
          props: { mode: 0o755 },
          children: Array.from({ length: PER_DIR }, (_, k) => ({ type: 'file', name: `f${k}.jpg`, attrs: { mimetype: 'image/jpeg' } })),
        }]);
      }
      await vfs.update(ADMIN_ACCESS, '/recipes', { attrs: { [PROCESSING_ATTR]: ['renditions'] } });
      await vfs.update(ADMIN_ACCESS, '/recipes/soups', { attrs: { [PROCESSING_ATTR]: 'picture-vectors' } });
      for (const table of [nodesTable, attrsTable]) await ctx.pool.query(`ANALYZE ${table}`);
    });

    await t.step('the query reads the processing index', async () => {
      const sql = buildQuerySql({ types: ['directory'], where: [{ ref: PROCESSING_ATTR, op: 'exists' }], limit: 1000 }, nodesTable, attrsTable);
      const client = await ctx.pool.connect();
      try {
        for (const generic of [false, true]) {
          const plan = await planOf(client, sql, generic);
          assert(new RegExp(`Index[^\\n]*${attrsTable}_processing_idx`).test(plan), `${generic ? 'generic: ' : ''}${plan}`);
        }
      } finally {
        client.release();
      }
    });

    await t.step('the lookup answers both folders, the deeper first', async () => {
      assertEquals(await processingRoots(vfs), [
        { path: '/recipes/soups', families: ['picture-vectors'] },
        { path: '/recipes', families: ['renditions'] },
      ]);
    });
  } finally {
    await dispose();
  }
});
