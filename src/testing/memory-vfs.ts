import { ADMIN_ACCESS } from '../lib/access/mod.ts';
import type { RouterManagerIf } from '../managers/router/mod.ts';
import { MemoryBlobRegistry } from '../registries/blob/mod.ts';
import { MemoryEmbeddingRegistry } from '../registries/embedding/mod.ts';
import { DiskFileRegistry, MemoryFileRegistry, TieredFileRegistry } from '../registries/file/mod.ts';
import { MemoryPositionRegistry } from '../registries/position/mod.ts';
import { MemoryLogRegistry } from '../registries/log/mod.ts';
import { NullRegistry } from '../registries/null/mod.ts';
import { MemoryPoolRegistry } from '../registries/pool/mod.ts';
import { MemoryQueueRegistry } from '../registries/queue/mod.ts';
import { RouterRegistry } from '../registries/router/mod.ts';
import { MemoryTrackRegistry } from '../registries/track/mod.ts';
import { InMemoryStore } from '../stores/memory/index.ts';
import { LocalNodeVFS } from '../vfs/mod.ts';

export type MemoryTestVfsOptions = {
  /** back files with this directory instead of memory */
  fileRoot?: string;
  /** mount the data VFS at `/` under a router-only root, as the primary instance does */
  rootMount?: boolean;
  /** subtrees whose writes leave no audit record, as the `noaudit` mount option names them */
  unaudited?: readonly string[];
};

export type MemoryTestVfs = {
  vfs: LocalNodeVFS;
  store: InMemoryStore;
};

/** Build the in-memory VFS shared by the direct and system test harnesses. */
export async function createMemoryTestVfs(
  routerManager: RouterManagerIf,
  options: MemoryTestVfsOptions = {},
): Promise<MemoryTestVfs> {
  const store = new InMemoryStore({ audit: true });
  const dataVfs = new LocalNodeVFS(store, routerManager, {
    file: new TieredFileRegistry({
      disk: options.fileRoot ? new DiskFileRegistry({ rootPath: options.fileRoot }) : new MemoryFileRegistry(),
      db: new MemoryBlobRegistry(),
    }),
    embedding: new MemoryEmbeddingRegistry(),
    position: new MemoryPositionRegistry(),
    log: new MemoryLogRegistry({ router: routerManager }),
    null: new NullRegistry(),
    pool: new MemoryPoolRegistry(),
    queue: new MemoryQueueRegistry({ router: routerManager }),
    router: new RouterRegistry({ router: routerManager }),
    track: new MemoryTrackRegistry({ router: routerManager }),
  }, { unaudited: options.unaudited });

  if (!options.rootMount) {
    await dataVfs.initialize();
    return { vfs: dataVfs, store };
  }

  // Production starts with this router-only VFS, then mounts the pg-backed
  // data VFS at `/`. Keeping the registries on dataVfs is the important part:
  // a command that incorrectly reaches into the returned root cannot see them.
  const rootVfs = new LocalNodeVFS(new InMemoryStore({}), routerManager, {
    router: new RouterRegistry({ router: routerManager }),
  });
  await rootVfs.initialize();
  await rootVfs.mount(ADMIN_ACCESS, '/', dataVfs);

  return { vfs: rootVfs, store };
}
