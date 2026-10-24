import type { UserId } from '../../lib/mode/mod.ts';
import { Node, NodeAttrs, NodeType } from '../node.ts';

/** A share link's record: what opens it, who it is, what it opens, until when, and how often it was opened. */
export type ShareLinkAttrs = NodeAttrs & {
  /** What the link's URL carries. Kept so whoever may change the node can copy the link again. */
  token: string;
  /** The link's principal, from `LINK_UID_BASE` up: what it opens grants this uid, and whoever opens it acts as it. */
  uid: UserId;
  /** Id of the node the link opens, with everything below it. */
  target: string;
  createdBy: UserId;
  createdAt: number;
  /** Epoch ms after which the link opens nothing; absent for one that does not expire. */
  expiresAt?: number;
  opened: number;
  lastOpenedAt?: number;
};

export const NODE_TYPE_SHARE_LINK: NodeType = 'share-link';

/** Whether a node is a share link's record: a `share-link` node with a token, a uid and a target. */
export const isShareLinkNode = (node: Node): node is Node<ShareLinkAttrs> =>
  node.type === NODE_TYPE_SHARE_LINK && typeof node.attrs.token === 'string' && typeof node.attrs.uid === 'number' &&
  typeof node.attrs.target === 'string';
