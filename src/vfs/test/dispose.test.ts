/**
 * VFS dispose: a VFS stops every registry it was given, and those of its mounts, once the writes
 * under way have finished with their storage; no write starts after it.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { RouterManager } from '../../managers/router/mod.ts';
import { MemoryEmbeddingRegistry } from '../../registries/embedding/memory-embedding-registry.ts';
import { RouterRegistry } from '../../registries/router/mod.ts';
import { InMemoryStore } from '../../stores/memory/index.ts';
import { NodeTransactionError } from '../errors.ts';
import { LocalNodeVFS } from '../mod.ts';

/** A router registry that records whether it was disposed. */
class TrackedRouterRegistry extends RouterRegistry {
  disposed = false;

  override async dispose(): Promise<void> {
    this.disposed = true;
    await super.dispose();
  }
}

Deno.test("VFS dispose stops its own and its mounts' router registries", async () => {
  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();

  try {
    const rootRouter = new TrackedRouterRegistry({ router: routerManager });
    const root = new LocalNodeVFS(new InMemoryStore({}), routerManager, { router: rootRouter });
    await root.initialize();

    const mountedRouter = new TrackedRouterRegistry({ router: routerManager });
    const mounted = new LocalNodeVFS(new InMemoryStore({}), routerManager, { router: mountedRouter });
    await root.create(ADMIN_ACCESS, 'directory', '/', 'mnt', { props: { mode: 0o755 } });
    await root.mount(ADMIN_ACCESS, '/mnt', mounted);

    await root.dispose();

    assertEquals(rootRouter.disposed, true);
    assertEquals(mountedRouter.disposed, true);
  } finally {
    await routerManager.dispose();
  }
});

/** An embedding registry whose deletes wait for `release`, recording the order of deletes and its dispose. */
class GatedEmbeddingRegistry extends MemoryEmbeddingRegistry {
  calls: string[] = [];
  deleting = Promise.withResolvers<void>();
  gate = Promise.withResolvers<void>();

  override async delete(id: string): Promise<boolean> {
    this.deleting.resolve();
    await this.gate.promise;
    this.calls.push('delete');
    return await super.delete(id);
  }

  override async dispose(): Promise<void> {
    this.calls.push('dispose');
    await super.dispose();
  }
}

Deno.test('VFS dispose waits for a delete to remove its storage, then refuses writes', async () => {
  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();

  try {
    const embedding = new GatedEmbeddingRegistry();
    const vfs = new LocalNodeVFS(new InMemoryStore({}), routerManager, { embedding });
    await vfs.initialize();
    await vfs.create(ADMIN_ACCESS, 'embedding', '/', 'vector', { attrs: { embeddingType: 'look', capacity: 3 } });
    const handle = await vfs.open(ADMIN_ACCESS, '/vector', { mode: 'w' });
    await handle.write(new TextEncoder().encode('[1,0,0]'));
    await handle.close();
    const id = (await vfs.get(ADMIN_ACCESS, '/vector')).id;

    // The node's delete has committed and its storage delete is under way when dispose begins.
    const unlinked = vfs.unlink(ADMIN_ACCESS, '/vector', '/');
    await embedding.deleting.promise;
    const disposed = vfs.dispose();
    embedding.gate.resolve();
    await unlinked;
    await disposed;

    assertEquals(embedding.calls, ['delete', 'dispose']);
    assertEquals(await embedding.exists(id), false);
    await assertRejects(() => vfs.create(ADMIN_ACCESS, 'directory', '/', 'late', { props: { mode: 0o755 } }), NodeTransactionError);
  } finally {
    await routerManager.dispose();
  }
});
