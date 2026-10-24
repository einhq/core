import { NodeType } from '../node.ts';
import { NODE_TYPE_SESSION } from './session.ts';
import { NODE_TYPE_TTY } from './tty.ts';

/**
 * Node types whose state does not outlive the process.
 *
 * A session or tty node is created when a connection opens and removed when it
 * closes; one that survives a crash carries a stale `bootId` and `session-reap`
 * removes it. So losing one of these writes to a crash changes nothing, and
 * the VFS declares them as such (`Transaction.declareWrite`) so a store may
 * commit them without waiting for its log to reach disk.
 */
export const EPHEMERAL_NODE_TYPES: ReadonlySet<NodeType> = new Set([NODE_TYPE_SESSION, NODE_TYPE_TTY]);
