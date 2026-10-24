/**
 * PG tier: a node write whose registry needs its own connection does not
 * starve the pool. More concurrent embedding creates than the pool has
 * connections all complete, each with its registry entry.
 * Gated by EIN_TEST_PG.
 */

import { assert, assertEquals } from '@std/assert';
import { Pool } from 'pg';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { RouterManager } from '../../../managers/router/mod.ts';
import { EmbeddingRegistry } from '../../../registries/embedding/mod.ts';
import { PG_URL, pgTest } from '../../../testing/gates.ts';
import { LocalNodeVFS } from '../../../vfs/mod.ts';
import { PgStore } from '../index.ts';
import { ulid } from '@std/ulid/ulid';

const POOL_MAX = 4;
const CONNECT_TIMEOUT_MS = 5_000;

pgTest('PgStore embedding creates beyond the pool size all complete', async () => {
  // Small, with a connect timeout, so a write waiting on its own pool fails
  // its registry call instead of hanging the run.
  const pool = new Pool({ connectionString: PG_URL, max: POOL_MAX, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  const prefix = `t${ulid().toLowerCase()}`;

  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();

  const embedding = new EmbeddingRegistry({ pool, name: prefix });
  const vfs = new LocalNodeVFS(new PgStore({ pgPool: pool, name: prefix }), routerManager, { embedding });
  await vfs.initialize();

  try {
    // One parent each: creates under one parent take the same lock and would
    // never run concurrently.
    const writers = POOL_MAX + 1;
    for (let i = 0; i < writers; i++) {
      await vfs.create(ADMIN_ACCESS, 'directory', '/', `d${i}`, { props: { mode: 0o755 } });
    }

    const started = performance.now();
    const nodes = await Promise.all(
      Array.from({ length: writers }, (_, i) =>
        vfs.createTree(ADMIN_ACCESS, `/d${i}`, [{
          type: 'embedding',
          name: 'clip',
          attrs: { embeddingType: 'starve', capacity: 3 },
        }])),
    );
    const elapsed = performance.now() - started;

    for (const [node] of nodes) {
      assertEquals(await embedding.exists(node.id), true, `registry entry for ${node.id}`);
    }
    assert(elapsed < CONNECT_TIMEOUT_MS, `creates took ${Math.round(elapsed)} ms`);
  } finally {
    await vfs.dispose();
    await routerManager.dispose();

    const res = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE $1`,
      [`${prefix}%`],
    );
    for (const row of res.rows) {
      await pool.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
    }
    await pool.end();
  }
});
