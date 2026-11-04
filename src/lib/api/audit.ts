/**
 * What the VFS audit trail and the access log record, and what `audit` and `access-log` answer
 * with: the first what changed, the second who reached EiN and what they took away.
 */

import type { NodeId, NodePath, UserId } from './ids.ts';
import type { ShellOrigin } from './system.ts';

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
  /** The session or pipeline run the write came from (`pipeline:<pipeline>/<instance id>`), when it came from one. */
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
  /** Writes of this session, SSH connection or pipeline run (`AuditRecord.sid`). */
  sid?: string;
  /** `false`: no writes of pipeline runs, only what people, imports and services wrote. `true`: only those. */
  pipeline?: boolean;
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

/**
 * Which records `auditPurge` removes: those written before `before` (milliseconds since the epoch),
 * and with `pipeline` only the writes of pipeline runs, whose `sid` starts with `pipeline:`.
 */
export type AuditPurge = { before: number; pipeline?: boolean };

/** `audit`: one record, with the account name resolved when the account still exists. */
export type AuditEntry = AuditRecord & { username?: string };

/**
 * What happened. `download` is an original file's contents sent to someone, saved or shown;
 * `download-archive` a selection sent as one zip; `link-open` a share link opened.
 */
export type AccessEvent =
  | 'sign-in'
  | 'sign-in-failed'
  | 'sign-out'
  | 'elevate'
  | 'elevate-failed'
  | 'link-open'
  | 'download'
  | 'download-archive';

export const ACCESS_EVENTS: readonly AccessEvent[] = [
  'sign-in',
  'sign-in-failed',
  'sign-out',
  'elevate',
  'elevate-failed',
  'link-open',
  'download',
  'download-archive',
];

/** How the client reached EiN: a shell's origin, `sftp`, or `http` for a file fetched by URL. */
export type AccessVia = ShellOrigin | 'sftp' | 'http';

/**
 * One sign-in, sign-out, share-link opening or download. Unlike the audit trail, which records
 * what changed, this records who reached EiN, from where, and what they took away.
 */
export type AccessRecord = {
  /** Monotonic ULID: ids sort in the order the events happened. */
  id: string;
  /** Milliseconds since the epoch. */
  timestamp: number;
  event: AccessEvent;
  /**
   * Who: the account, or a share link's principal. Absent when a failed sign-in named no account;
   * what was typed is not kept, since it is sometimes a password.
   */
  uid?: UserId;
  /** The session or SSH connection, as the audit trail records it on that session's writes. */
  sid?: string;
  /** The client's address. */
  from?: string;
  via?: AccessVia;
  /** `sign-in` over SSH: how the client proved who it is. */
  method?: 'password' | 'publickey';
  /** A failed sign-in or elevation: why, as the client was told. */
  reason?: string;
  /** `link-open`, and a download made through a share link: the link's id. */
  linkId?: string;
  /** `link-open`: what the link opens. `download`: the file. `download-archive`: the folder holding the selection. */
  path?: NodePath;
  /** `download-archive`: how many files the zip holds. */
  count?: number;
};

/**
 * Which records `access-log` reads. Every field narrows; none returns the newest records, newest
 * first. With `after` the log is read forward instead: the records after that id, oldest first.
 */
export type AccessLogQuery = {
  /** The one record with this id. */
  id?: string;
  uid?: UserId;
  /** Only these events. */
  events?: AccessEvent[];
  sid?: string;
  from?: string;
  linkId?: string;
  /** The path itself and everything below it. */
  pathPrefix?: NodePath;
  /** Inclusive, milliseconds since the epoch. */
  since?: number;
  /** Exclusive, milliseconds since the epoch. */
  until?: number;
  /** Only records after this id (exclusive), oldest first. */
  after?: string;
  /** Defaults to 100. */
  limit?: number;
};

/** Which records `accessLogPurge` removes: those written before `before` (milliseconds since the epoch). */
export type AccessLogPurge = { before: number };

/** `access-log`: one record, with the account name resolved when the account still exists. */
export type AccessLogEntry = AccessRecord & { username?: string };
