/**
 * VFS dispose: a VFS stops every registry it was given, and those of its mounts.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { RouterManager } from '../../managers/router/mod.ts';
import { RouterRegistry } from '../../registries/router/mod.ts';
import { InMemoryStore } from '../../stores/memory/index.ts';
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
