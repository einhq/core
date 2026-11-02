/**
 * PG tier: a node's delete records its registry storage in the delete's own transaction, and the
 * record goes once the storage is gone. Storage whose removal did not happen — the process killed
 * after the commit — is removed when a VFS over the same tables next initializes.
 * Gated by EIN_TEST_PG.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { RouterManager } from '../../../managers/router/mod.ts';
import { MemoryEmbeddingRegistry } from '../../../registries/embedding/mod.ts';
import { pgTest, pgTestContext } from '../../../testing/gates.ts';
import { LocalNodeVFS } from '../../../vfs/mod.ts';
import { PgStore } from '../index.ts';

/** An embedding registry whose deletes fail while `failing`, as a removal a killed process never made. */
class FailingEmbeddingRegistry extends MemoryEmbeddingRegistry {
  failing = false;

  override async delete(id: string): Promise<boolean> {
    if (this.failing) throw new Error('storage unreachable');
    return await super.delete(id);
  }

  /** The entries outlive a VFS, as storage outlives a process. */
  override async dispose(): Promise<void> {}
}

pgTest('PgStore storage deletes', async (t) => {
  const ctx = pgTestContext();
  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();

  const embedding = new FailingEmbeddingRegistry();
  const store = new PgStore({ pgPool: ctx.pool, name: ctx.prefix });
  const vfs = new LocalNodeVFS(store, routerManager, { embedding });
  await vfs.initialize();

  const vector = async (name: string) => {
    const node = await vfs.create(ADMIN_ACCESS, 'embedding', '/', name, { attrs: { embeddingType: 'look', capacity: 3 } });
    const handle = await vfs.open(ADMIN_ACCESS, `/${name}`, { mode: 'w' });
    await handle.write(new TextEncoder().encode('[1,0,0]'));
    await handle.close();
    return node.id;
  };

  try {
    await t.step('a delete that removes its storage leaves no record', async () => {
      const id = await vector('kept');
      await vfs.unlink(ADMIN_ACCESS, '/kept', '/');

      assertEquals(await embedding.exists(id), false);
      assertEquals(await store.pendingStorageDeletes(), []);
    });

    await t.step('a rolled-back delete records nothing', async () => {
      const tx = await store.beginTransaction();
      await store.recordStorageDeletes([{ id: 'x'.repeat(26), type: 'embedding' }], tx);
      await tx.rollback();

      assertEquals(await store.pendingStorageDeletes(), []);
    });

    await t.step('storage a delete did not remove is removed at the next initialize', async () => {
      const one = await vector('one');
      const two = await vector('two');
      const three = await vector('three');

      embedding.failing = true;
      await vfs.unlink(ADMIN_ACCESS, '/one', '/');
      await vfs.unlinkMany(ADMIN_ACCESS, ['/two', '/three']);
      embedding.failing = false;

      assertEquals([await embedding.exists(one), await embedding.exists(two), await embedding.exists(three)], [true, true, true]);
      assertEquals((await store.pendingStorageDeletes()).map((d) => d.id).sort(), [one, two, three].sort());

      const restarted = new LocalNodeVFS(new PgStore({ pgPool: ctx.pool, name: ctx.prefix }), routerManager, { embedding });
      await restarted.initialize();

      assertEquals([await embedding.exists(one), await embedding.exists(two), await embedding.exists(three)], [false, false, false]);
      assertEquals(await store.pendingStorageDeletes(), []);
    });
  } finally {
    await routerManager.dispose();
    await ctx.teardown();
  }
});
