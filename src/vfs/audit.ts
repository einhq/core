/**
 * Building the VFS audit trail's records. The store writes them in the mutation's own transaction.
 */

import { monotonicUlid } from '@std/ulid';
import type { AuditChange, AuditOp, AuditQuery, AuditRecord } from '../lib/api/audit.ts';
import type { Access } from '../lib/access/types.ts';
import type { Node, NodePath } from './node.ts';

export type { AuditChange, AuditOp, AuditQuery, AuditRecord } from '../lib/api/audit.ts';

/** What a mutation site knows about one write. */
export type AuditInput = {
  op: AuditOp;
  /** The node after the write; for `delete`/`unlink`, as it was. */
  node: Node;
  path: NodePath;
  fromPath?: NodePath;
  /** `update`: the node before the write, to diff against. */
  previousNode?: Node;
};

/**
 * Largest value, serialised, a record carries verbatim. Past it the value is replaced by its size:
 * the trail still says the attr changed, without a face list or an OCR page bloating every row.
 */
export const AUDIT_VALUE_MAX_BYTES = 8192;

/** The props a write can change on purpose; `changetime`, `modtime` and `count` follow from the write. */
const AUDITED_PROPS = ['mode', 'uid', 'gid', 'acl', 'tier', 'softlink'] as const;

const encoder = new TextEncoder();

/** A value as the trail stores it: verbatim, or its size when it is too large to keep. */
const auditValue = (value: unknown): unknown => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'string')) return value;
  const bytes = encoder.encode(JSON.stringify(value)).length;
  return bytes > AUDIT_VALUE_MAX_BYTES ? { truncated: true, bytes } : value;
};

/** Structural values are compared serialised — attrs are JSON, so that is their identity. */
const sameValue = (a: unknown, b: unknown): boolean =>
  a === b || (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));

/** Every key whose value differs between two records, as `{ from, to }`. `undefined` when none did. */
const diffValues = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  keys: Iterable<string> = new Set([...Object.keys(before), ...Object.keys(after)]),
): Record<string, AuditChange> | undefined => {
  const changes: Record<string, AuditChange> = {};
  let any = false;

  for (const key of keys) {
    if (sameValue(before[key], after[key])) continue;
    const change: AuditChange = {};
    if (before[key] !== undefined) change.from = auditValue(before[key]);
    if (after[key] !== undefined) change.to = auditValue(after[key]);
    changes[key] = change;
    any = true;
  }

  return any ? changes : undefined;
};

/**
 * One record from what a mutation site saw. `create` carries the attrs it set and `delete` the
 * attrs it removed, so the trail alone is enough to see — and to restore — what a node held. An
 * `update` that changed none of them (a setup step re-applying the mode a directory already has)
 * has nothing to say, and gives no record.
 */
export const auditRecord = (access: Access, input: AuditInput): AuditRecord | undefined => {
  const { op, node, path, fromPath, previousNode } = input;

  let attrs: Record<string, AuditChange> | undefined;
  let props: Record<string, AuditChange> | undefined;

  if (op === 'create') {
    attrs = diffValues({}, node.attrs);
  } else if (op === 'delete') {
    attrs = diffValues(node.attrs, {});
  } else if (op === 'update' && previousNode) {
    attrs = diffValues(previousNode.attrs, node.attrs);
    props = diffValues(previousNode.props, node.props, AUDITED_PROPS);
    if (!attrs && !props) return undefined;
  }

  return {
    id: monotonicUlid(),
    timestamp: Date.now(),
    uid: access.uid,
    ...(access.sid ? { sid: access.sid } : {}),
    ...(access.cause ? { cause: access.cause } : {}),
    op,
    nodeId: node.id,
    nodeType: node.type,
    path,
    ...(fromPath ? { fromPath } : {}),
    ...(attrs ? { attrs } : {}),
    ...(props ? { props } : {}),
  };
};

/** Whether `path` is `prefix` itself or lies below it. */
export const isPathWithin = (path: NodePath, prefix: NodePath): boolean => prefix === '/' || path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/');

/** Whether one record answers a query's filters (the limit is the caller's). */
export const auditMatches = (record: AuditRecord, query: AuditQuery): boolean => {
  if (query.id !== undefined && record.id !== query.id) return false;
  if (query.uid !== undefined && record.uid !== query.uid) return false;
  if (query.nodeId !== undefined && record.nodeId !== query.nodeId) return false;
  if (query.cause !== undefined && record.cause !== query.cause) return false;
  if (query.op !== undefined && record.op !== query.op) return false;
  if (query.nodeTypes !== undefined && !query.nodeTypes.includes(record.nodeType)) return false;
  if (query.after !== undefined && record.id <= query.after) return false;
  if (query.since !== undefined && record.timestamp < query.since) return false;
  if (query.until !== undefined && record.timestamp >= query.until) return false;
  if (query.pathPrefix !== undefined) {
    const prefix = query.pathPrefix;
    const within = (path?: NodePath) => path !== undefined && isPathWithin(path, prefix);
    if (!within(record.path) && !within(record.fromPath)) return false;
  }
  return true;
};
