import { Access } from '../../lib/access/mod.ts';
import { NodeAttrs, NodeType } from '../node.ts';

export type TtyAttrs = NodeAttrs & {
  createdAt: number;
  lastActivity: number;

  /**
   * `BOOT_ID` of the process that opened this tty. A tty only exists while its
   * shell does, so any other value means the node was stranded by a crash or a
   * restart and `session-reap` may remove it.
   */
  bootId: string;

  // Terminal information
  access: Access;
  env: Record<string, string>;
  params: Record<string, string>;
  cwd: string;

  // Terminal size
  rows: number;
  cols: number;
};

export const NODE_TYPE_TTY: NodeType = 'tty';
