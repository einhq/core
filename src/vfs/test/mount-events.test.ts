/**
 * Queue events from a mounted VFS carry the absolute path.
 *
 * A mounted VFS sees its paths relative to its mount point; a write under /tmp
 * published as /x would resolve to nothing for a queue consumer. Only the
 * outermost VFS publishes, with the path rewritten at each mount on the way
 * out.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { RouterManager } from '../../managers/router/mod.ts';
import { MemoryPositionRegistry } from '../../registries/position/mod.ts';
import { InMemoryStore } from '../../stores/memory/index.ts';
import { createMemoryTestVfs } from '../../testing/memory-vfs.ts';
import { LocalNodeVFS } from '../mod.ts';

Deno.test('mounted VFS events reach the queues with absolute paths', async (t) => {
  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();

  const published: string[] = [];
  const off = routerManager.on((key, payload) => {
    published.push(`${key} ${(payload as { path: string }).path}`);
    return Promise.resolve();
  });

  // As production: a router-only root with the data VFS mounted at `/`.
  const { vfs } = await createMemoryTestVfs(routerManager, { rootMount: true });
  const memoryVfs = async () => {
    const mounted = new LocalNodeVFS(new InMemoryStore({}), routerManager, { position: new MemoryPositionRegistry() });
    await mounted.initialize();
    return mounted;
  };

  const settle = () => new Promise((r) => setTimeout(r, 20));
  /** Every position creation published for this node's name — a relative `/spot` included, which must never appear. */
  const created = async (path: string) => {
    await settle();
    const name = path.slice(path.lastIndexOf('/'));
    return published.filter((line) => line.startsWith('system.vfs.position.created ') && line.endsWith(name));
  };

  try {
    await t.step('the data VFS mounted at / keeps its paths, published once', async () => {
      await vfs.create(ADMIN_ACCESS, 'position', '/', 'here');
      assertEquals(await created('/here'), ['system.vfs.position.created /here']);
    });

    await t.step('a write under a mount is published under the mount point', async () => {
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'tmp');
      await vfs.mount(ADMIN_ACCESS, '/tmp', await memoryVfs());

      await vfs.create(ADMIN_ACCESS, 'position', '/tmp', 'spot');
      assertEquals(await created('/tmp/spot'), ['system.vfs.position.created /tmp/spot']);
    });

    await t.step('and under a mount inside a mount, the whole way out', async () => {
      await vfs.create(ADMIN_ACCESS, 'directory', '/tmp', 'inner');
      await vfs.mount(ADMIN_ACCESS, '/tmp/inner', await memoryVfs());

      await vfs.create(ADMIN_ACCESS, 'position', '/tmp/inner', 'deep');
      assertEquals(await created('/tmp/inner/deep'), ['system.vfs.position.created /tmp/inner/deep']);
    });

    await t.step('in-process subscribers see the absolute path too', async () => {
      const seen: string[] = [];
      const sub = await vfs.subscribe!(() => ADMIN_ACCESS, (event) => {
        if (event.type === 'created') seen.push(event.path);
      });
      await vfs.create(ADMIN_ACCESS, 'position', '/tmp/inner', 'watched');
      await settle();
      await sub.unsubscribe();
      assertEquals(seen, ['/tmp/inner/watched']);
    });

    await t.step('a mount with publish: false stays off the queues, even nested, but not off subscribers', async () => {
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'mirror');
      await vfs.mount(ADMIN_ACCESS, '/mirror', await memoryVfs(), { publish: false });
      await vfs.create(ADMIN_ACCESS, 'directory', '/mirror', 'inner');
      await vfs.mount(ADMIN_ACCESS, '/mirror/inner', await memoryVfs());

      const seen: string[] = [];
      const sub = await vfs.subscribe!(() => ADMIN_ACCESS, (event) => {
        if (event.type === 'created') seen.push(event.path);
      });
      await vfs.create(ADMIN_ACCESS, 'position', '/mirror', 'quiet');
      await vfs.create(ADMIN_ACCESS, 'position', '/mirror/inner', 'quieter');
      await settle();
      await sub.unsubscribe();

      assertEquals(await created('/mirror/quiet'), []);
      assertEquals(await created('/mirror/inner/quieter'), []);
      assertEquals(seen, ['/mirror/quiet', '/mirror/inner/quieter']);
    });
  } finally {
    off();
    await vfs.dispose();
    await routerManager.dispose();
  }
});
