import { ExecutionManager } from '../../managers/exec/mod.ts';
import type { BufferManagerIf } from '../../managers/buffer/mod.ts';
import { NodePath, NodeVFS } from '../../vfs/mod.ts';
import { SessionConfig } from './session.ts';

export type HttpServerConfig = SessionConfig & {
  port: number;
  cem: ExecutionManager;
  vfs: NodeVFS;
  bufferManager: BufferManagerIf;
  rootPath: NodePath;
  env: Record<string, string>;
  signal: AbortSignal;
  onListen?: (info: Deno.NetAddr) => void;
};
