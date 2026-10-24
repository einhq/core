import type { Pool } from 'pg';
import type { RouterManagerIf } from '../managers/router/mod.ts';
import { PgBlobRegistry } from '../registries/blob/mod.ts';
import { EmbeddingRegistry, MemoryEmbeddingRegistry } from '../registries/embedding/mod.ts';
import { MemoryFileRegistry, TieredFileRegistry } from '../registries/file/mod.ts';
import { MemoryPositionRegistry } from '../registries/position/mod.ts';
import { MemoryLogRegistry } from '../registries/log/mod.ts';
import { NullRegistry } from '../registries/null/mod.ts';
import { MemoryPoolRegistry } from '../registries/pool/mod.ts';
import { PgQueueRegistry } from '../registries/queue/mod.ts';
import { RouterRegistry } from '../registries/router/mod.ts';
import { MemoryTrackRegistry } from '../registries/track/mod.ts';
import { PgStore } from '../stores/pg/index.ts';
import { LocalNodeVFS } from '../vfs/mod.ts';

/**
 * Where a PostgreSQL test VFS keeps its tables: a pool, and the prefix its tables carry; with
 * `embeddings`, vectors too, in pgvector tables with their HNSW indexes, for a test of what an
 * index lookup costs.
 */
export type PgTestVfsOptions = { pool: Pool; prefix: string; embeddings?: boolean };

/**
 * The test VFS on PostgreSQL: the node store, the db file tier and the queues in tables under
 * `prefix`, so what a command costs there — statements, and the events it publishes to bound
 * queues — is what it costs on a deployment. File content and the other registries stay in memory,
 * and so do vectors unless `embeddings` is asked for.
 */
export async function createPgTestVfs(routerManager: RouterManagerIf, options: PgTestVfsOptions): Promise<LocalNodeVFS> {
  const { pool, prefix } = options;
  const vfs = new LocalNodeVFS(new PgStore({ pgPool: pool, name: prefix }), routerManager, {
    file: new TieredFileRegistry({ disk: new MemoryFileRegistry(), db: new PgBlobRegistry({ pool, prefix }) }),
    embedding: options.embeddings ? new EmbeddingRegistry({ pool, name: prefix }) : new MemoryEmbeddingRegistry(),
    position: new MemoryPositionRegistry(),
    log: new MemoryLogRegistry({ router: routerManager }),
    null: new NullRegistry(),
    pool: new MemoryPoolRegistry(),
    queue: new PgQueueRegistry({ router: routerManager, name: prefix, pool }),
    router: new RouterRegistry({ router: routerManager }),
    track: new MemoryTrackRegistry({ router: routerManager }),
  });
  await vfs.initialize();
  return vfs;
}
