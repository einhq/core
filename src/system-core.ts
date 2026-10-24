import { Pool } from 'pg';
import type { BufferManagerIf } from './managers/buffer/mod.ts';
import type { ExecutionManager } from './managers/exec/mod.ts';
import type { RouterManagerIf } from './managers/router/mod.ts';
import type { ServiceManager } from './managers/services/mod.ts';
import type { ShellManagerIf } from './managers/shell/mod.ts';
import type { NodeVFS } from './vfs/mod.ts';

export type SystemCore = {
  vfs: NodeVFS;
  bufferManager: BufferManagerIf;
  routerManager: RouterManagerIf;

  /** Execution manager (set during boot after construction) */
  execManager?: ExecutionManager;

  /** Service manager (set during boot after construction) */
  serviceManager?: ServiceManager;

  /** Shell manager (set during boot after construction) */
  shellManager?: ShellManagerIf;

  /** PostgreSQL pool */
  pgPool?: Pool;

  /**
   * Pool for LISTEN/NOTIFY connections only.
   *
   * A notification connection is held for the lifetime of the registry that
   * opened it and can never serve a query, so four of them — log, queue, pool
   * and track — would be four of `pgPool`'s twenty permanently subtracted from
   * the work it exists to do. Separate rather than merely reserved because the
   * lifetime is the whole point: nothing else should ever be able to take one
   * of these, and they should never be able to take a work connection.
   *
   * Absent means "use `pgPool`", which is what the harness and the in-memory
   * mounts get.
   */
  pgListenPool?: Pool;
};
