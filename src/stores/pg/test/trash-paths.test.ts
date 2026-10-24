/**
 * PG tier: trashed nodes have no path to id lookups (`src/vfs/test/trash-cases.ts`), through the
 * store's own path resolution and its path cache. Gated by EIN_TEST_PG.
 */

import { RouterManager } from '../../../managers/router/mod.ts';
import { MemoryFileRegistry } from '../../../registries/file/mod.ts';
import { pgTest, pgTestContext } from '../../../testing/gates.ts';
import { LocalNodeVFS } from '../../../vfs/mod.ts';
import { trashCases } from '../../../vfs/test/trash-cases.ts';
import { PgStore } from '../index.ts';

pgTest('PgStore leaves trashed nodes out of id lookups', async (t) => {
  const ctx = pgTestContext();
  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();
  const vfs = new LocalNodeVFS(new PgStore({ pgPool: ctx.pool, name: ctx.prefix }), routerManager, { file: new MemoryFileRegistry() });
  await vfs.initialize();

  try {
    await trashCases(vfs, (name, fn) => t.step(name, fn));
  } finally {
    await vfs.dispose();
    await routerManager.dispose();
    await ctx.teardown();
  }
});
