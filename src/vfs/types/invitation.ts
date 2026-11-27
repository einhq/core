import type { UserId } from '../../lib/mode/mod.ts';
import { Node, NodeAttrs, NodeType } from '../node.ts';

/** How an invitation opens one of its nodes: a stream to read it or to write it, a socket to connect to it. */
export type InvitationMode = 'r' | 'w' | 'rw';

/**
 * An invitation's record: the stream and socket nodes it opens and how, whose access it opens them with, until
 * when, and how often it was used. Its token is kept only as a hash.
 */
export type InvitationAttrs = NodeAttrs & {
  /** The SHA-256 of the token its link carries, in hex. */
  hash: string;
  /** The nodes it opens, by id, so a node moved stays open; each in its one mode. */
  nodes: { id: string; mode: InvitationMode }[];
  /** Whose access a node is opened with: an invitation never reaches what its creator does not. */
  createdBy: UserId;
  createdAt: number;
  /** Epoch ms after which it opens nothing. */
  expiresAt: number;
  /** How many sockets it opened, and when last. */
  opened: number;
  lastOpenedAt?: number;
};

export const NODE_TYPE_INVITATION: NodeType = 'invitation';

/** Whether a node is an invitation's record. */
export const isInvitationNode = (node: Node): node is Node<InvitationAttrs> =>
  node.type === NODE_TYPE_INVITATION && typeof node.attrs.hash === 'string' && Array.isArray(node.attrs.nodes) && typeof node.attrs.createdBy === 'number' &&
  typeof node.attrs.expiresAt === 'number';
