/**
 * Test VFS
 *
 * Builds a bare in-memory LocalNodeVFS with the full memory registry set for
 * direct VFS unit tests (no servers, no shell).
 */

import { BufferManager } from '../managers/buffer/mod.ts';
import { RouterManager } from '../managers/router/mod.ts';
import { InMemoryStore } from '../stores/memory/index.ts';
import { LocalNodeVFS } from '../vfs/mod.ts';
import { createMemoryTestVfs } from './memory-vfs.ts';

export type TestVfsOptions = {
  /** mount the data VFS at `/` under a router-only root, as the primary instance does */
  rootMount?: boolean;
  /** subtrees whose writes leave no audit record, as the `noaudit` mount option names them */
  unaudited?: readonly string[];
};

export type TestVfs = {
  vfs: LocalNodeVFS;
  /** Exposed so tests can assert on the hierarchy edges directly. */
  store: InMemoryStore;
  routerManager: RouterManager;
  bufferManager: BufferManager;
  dispose(): Promise<void>;
};

export async function createTestVfs(options: TestVfsOptions = {}): Promise<TestVfs> {
  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();

  const bufferManager = new BufferManager();
  await bufferManager.init();

  const { vfs, store } = await createMemoryTestVfs(routerManager, options);

  return {
    vfs,
    store,
    routerManager,
    bufferManager,
    async dispose() {
      await vfs.dispose();
      await bufferManager.dispose();
      await routerManager.dispose();
    },
  };
}
