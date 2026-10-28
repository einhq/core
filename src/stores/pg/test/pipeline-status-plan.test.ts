/**
 * PG tier: what the planner knows about pipeline status. `status` has statistics, so the few
 * running steps among many finished ones are estimated as few rather than as one row in two
 * hundred of the table, which is what keeps the running lists off a parallel plan. The hierarchy
 * table is vacuumed at a hundredth of its size, so child counts stay index-only scans under
 * churn. Gated by EIN_TEST_PG.
 */

import { assert, assertEquals } from '@std/assert';
import type { Pool } from 'pg';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { RouterManager } from '../../../managers/router/mod.ts';
import { MemoryFileRegistry } from '../../../registries/file/mod.ts';
import { pgTest, pgTestContext } from '../../../testing/gates.ts';
import { LocalNodeVFS } from '../../../vfs/mod.ts';
import { PgStore } from '../index.ts';
import { buildQuerySql } from '../query.ts';

const FILES = 3000;
const FINISHED = 1000;
const RUNNING = 2;

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

pgTest('running steps are estimated as the few they are', async (t) => {
  const ctx = pgTestContext();
  const { vfs, dispose } = await createPgVfs(ctx.pool, ctx.prefix);
  const nodesTable = `${ctx.prefix}_nodes`;
  const attrsTable = `${nodesTable}_attr`;
  const hierarchyTable = `${nodesTable}_lnk`;
  try {
    await vfs.createTree(ADMIN_ACCESS, '/', [{
      type: 'directory',
      name: 'files',
      children: Array.from({ length: FILES }, (_, k) => ({ type: 'file', name: `f${k}.jpg`, attrs: { mimetype: 'image/jpeg' } })),
    }, {
      type: 'directory',
      name: 'steps',
      children: Array.from({ length: FINISHED + RUNNING }, (_, k) => ({
        type: 'file',
        name: `s${k}`,
        attrs: { stepName: 'thumb', status: k < RUNNING ? 'running' : 'completed', startedAt: 1_000 + k },
      })),
    }]);
    await ctx.pool.query(`ANALYZE ${attrsTable}`);

    await t.step('the quiet list is estimated near its count', async () => {
      const sql = buildQuerySql(
        {
          where: [{ ref: 'stepName', op: 'exists' }, { ref: 'status', op: 'eq', value: 'running' }],
          orderBy: { ref: 'startedAt', dir: 'asc' },
          limit: 500,
        },
        nodesTable,
        attrsTable,
      );
      const explained = await ctx.pool.query<{ 'QUERY PLAN': [{ Plan: { 'Plan Rows': number } }] }>(`EXPLAIN (FORMAT JSON) ${sql.text}`, sql.values);
      const estimate = explained.rows[0]['QUERY PLAN'][0].Plan['Plan Rows'];
      // One row in two hundred of the table would be 20.
      assert(estimate <= 2 * RUNNING, `estimated ${estimate} running steps`);
      assertEquals((await ctx.pool.query(sql.text, sql.values)).rows.length, RUNNING);
    });

    await t.step('the hierarchy table is vacuumed at a hundredth of its size', async () => {
      const { rows } = await ctx.pool.query<{ reloptions: string[] }>(`SELECT reloptions FROM pg_class WHERE oid = $1::regclass`, [hierarchyTable]);
      for (const option of ['autovacuum_vacuum_scale_factor=0.01', 'autovacuum_vacuum_insert_scale_factor=0.01']) {
        assert(rows[0].reloptions.includes(option), `${option} missing from ${rows[0].reloptions}`);
      }
    });
  } finally {
    await dispose();
  }
});
