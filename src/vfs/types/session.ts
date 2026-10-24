import { Access } from '../../lib/access/mod.ts';
import { Node, NodeAttrs, NodeType } from '../node.ts';

export type SessionAttrs = NodeAttrs & {
  secret: string;
  access: Access;
  createdAt: number;
  lastActivity: number;
  expiresSec?: number;
  expired?: boolean;
  env: Record<string, string>;

  /**
   * `BOOT_ID` of the process that created this session, when the session is
   * reachable only from that process — an SSH channel, or a WebSocket shell
   * whose client never received the cookie. Absent for cookie-backed HTTP
   * sessions, which are meant to survive a restart. See `session-reap`.
   */
  bootId?: string;
};

export const NODE_TYPE_SESSION: NodeType = 'session';

/**
 * Whether a node is a session: a `session` node with a secret. A cookie names only these, so
 * another node under the sessions directory with a `secret` and an `access` attr is nobody's.
 */
export const isSessionNode = (node: Node): node is Node<SessionAttrs> => node.type === NODE_TYPE_SESSION && typeof node.attrs.secret === 'string';
