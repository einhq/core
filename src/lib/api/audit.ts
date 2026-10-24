/** What the VFS audit trail records, and what `audit` answers with. */

import type { NodeId, NodePath, UserId } from './ids.ts';

/**
 * What a VFS write did to one node.
 *
 * `link` and `unlink` add and drop one name of a node that lives on under another; `delete` is the
 * last name going, which removes the node itself.
 */
export type AuditOp = 'create' | 'update' | 'move' | 'link' | 'unlink' | 'delete';

/** One value before and after a write. An absent side is `undefined`: the attr was added or removed. */
export type AuditChange = { from?: unknown; to?: unknown };

/**
 * One node write, committed in the same transaction as the write itself: a record exists exactly
 * when the change does. Session and tty writes are not recorded.
 */
export type AuditRecord = {
  /** Monotonic ULID: ids sort in the order the writes happened. */
  id: string;
  /** Milliseconds since the epoch. */
  timestamp: number;
  uid: UserId;
  /** The session or pipeline run the write came from (`pipeline:<instance id>`), when it came from one. */
  sid?: string;
  /** Id of the record of the write that set this one off: the write that started its pipeline run. */
  cause?: string;
  op: AuditOp;
  nodeId: NodeId;
  nodeType: string;
  /** Where the node is after the write — for `move` the new path, for `unlink`/`delete` the name that went. */
  path: NodePath;
  /** `move`: where it was. */
  fromPath?: NodePath;
  /** `update`: every attr whose value changed. An oversized value is replaced by `{ truncated, bytes }`. */
  attrs?: Record<string, AuditChange>;
  /** `update`: the node props that changed (`mode`, `uid`, `gid`, `acl`, `tier`, `softlink`). */
  props?: Record<string, AuditChange>;
};

/**
 * A write the trail recorded, as work it sets off carries it: its record's id and who made it. A
 * pipeline run started by the write records the id as the `cause` of every write it makes.
 */
export type AuditedWrite = { auditId: string; uid: UserId };

/**
 * Which records `audit` reads. Every field narrows; none returns the newest records, newest first.
 * With `after` the trail is read forward instead: the records after that id, oldest first, so a
 * reader can follow it by passing the last id it read.
 */
export type AuditQuery = {
  /** The one record with this id. */
  id?: string;
  uid?: UserId;
  nodeId?: NodeId;
  /** Writes set off by the write with this record id. */
  cause?: string;
  /** The path itself and everything below it; for `move` also matches the old path. */
  pathPrefix?: NodePath;
  op?: AuditOp;
  /** Only records of nodes of these types. */
  nodeTypes?: string[];
  /** Inclusive, milliseconds since the epoch. */
  since?: number;
  /** Exclusive, milliseconds since the epoch. */
  until?: number;
  /** Only records after this id (exclusive), oldest first. */
  after?: string;
  /** Defaults to 100. */
  limit?: number;
};

/** `audit`: one record, with the account name resolved when the account still exists. */
export type AuditEntry = AuditRecord & { username?: string };
