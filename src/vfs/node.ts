import type { FileTier } from '../registries/file/types.ts';
import { Ownership, UserId } from '../lib/mode/mod.ts';
import type { NodeId, NodePath } from '../lib/api/ids.ts';
export type { NodeId, NodePath } from '../lib/api/ids.ts';

export type NodeType = string;

/**
 * User+timestamp for tracking who did what when
 */
export type UserTime = {
  uid: UserId;
  timestamp: number;
};

/**
 * Child reference
 */
export type NodeChild = {
  id: NodeId;
  name: string;
  position?: number; // Order within parent
};

export type NodeSpecialProps = {
  // Special properties
  softlink?: NodePath;

  /**
   * Physical storage tier for a file's bytes ('disk' | 'volatile' | 'db').
   * Set once at creation and immutable thereafter: the bytes physically live on
   * the tier they were first written to, so changing this would strand them.
   * When unset it is derived from `sourceId`/`frozen` (see tierOf).
   */
  tier?: FileTier;
};

/**
 * Props - common metadata for all nodes (Unix-like)
 *
 * A node carries no list of its own children, so a read or a link costs the
 * same however large the directory is. The edges live in the hierarchy and are
 * asked for explicitly: `NodeVFS.children` / `childCount`.
 */
export type NodeProps = Ownership & NodeSpecialProps & {
  // Timestamps (who + when)
  birthtime: UserTime; // Created
  changetime: UserTime; // Props changed
  modtime: UserTime; // Attrs changed

  // Hierarchy
  count: number; // Link count (number of parents)
};

/**
 * Attrs - type-specific flexible data (JSONB)
 */
export type NodeAttrs = Record<string, any>;

/**
 * Node - complete node data
 */
export type Node<T extends NodeAttrs = NodeAttrs> = {
  id: NodeId;
  type: NodeType;
  props: NodeProps;
  attrs: T;
};
