/**
 * The access log: sign-ins, sign-outs, share links opened and downloads, kept by the store that
 * keeps the audit trail. Records are written by `recordAccess` and read by `NodeVFS.accessLog`.
 */

import { monotonicUlid } from '@std/ulid';
import type { AccessLogPurge, AccessLogQuery, AccessRecord } from '../lib/api/audit.ts';
import { createLogger } from '../managers/logger/mod.ts';
import { ARCHIVE_PATH, HOMES_PATH } from '../lib/paths.ts';
import { isPathWithin } from './audit.ts';
import type { Node, NodePath } from './node.ts';
import type { NodeVFS } from './node-vfs.ts';
import { isDerivedFile, NODE_TYPE_FILE } from './types/file.ts';

export type { AccessEvent, AccessLogPurge, AccessLogQuery, AccessRecord, AccessVia } from '../lib/api/audit.ts';

const logger = createLogger('access-log');

/** What the place an event happens knows of it; the id and time are added here. */
export type AccessInput = Omit<AccessRecord, 'id' | 'timestamp'>;

/** Whether one record answers a query's filters (the limit is the caller's). */
export const accessLogMatches = (record: AccessRecord, query: AccessLogQuery): boolean => {
  if (query.id !== undefined && record.id !== query.id) return false;
  if (query.uid !== undefined && record.uid !== query.uid) return false;
  if (query.events !== undefined && !query.events.includes(record.event)) return false;
  if (query.sid !== undefined && record.sid !== query.sid) return false;
  if (query.from !== undefined && record.from !== query.from) return false;
  if (query.linkId !== undefined && record.linkId !== query.linkId) return false;
  if (query.after !== undefined && record.id <= query.after) return false;
  if (query.since !== undefined && record.timestamp < query.since) return false;
  if (query.until !== undefined && record.timestamp >= query.until) return false;
  if (query.pathPrefix !== undefined && (record.path === undefined || !isPathWithin(record.path, query.pathPrefix))) return false;
  return true;
};

/**
 * Whether reading `node` at `path` is a `download` for the access log: a file someone put in the
 * archive or a home directory, not a rendition derived from one, nor a hidden file such as a
 * setting the UI reads.
 */
export const isLoggedDownload = (path: NodePath, node: Node): boolean =>
  node.type === NODE_TYPE_FILE &&
  !isDerivedFile(node.attrs) &&
  (isPathWithin(path, ARCHIVE_PATH) || isPathWithin(path, HOMES_PATH)) &&
  !path.split('/').some((segment) => segment.startsWith('.'));

/** Whether `accessLogPurge` removes this record. */
export const accessLogPurgeMatches = (record: AccessRecord, purge: AccessLogPurge): boolean => record.timestamp < purge.before;

/**
 * Add one event to the access log. Never throws: a log that cannot be written must not stop
 * anyone signing in or downloading, so a failure goes to the system log instead.
 */
export async function recordAccess(vfs: NodeVFS, input: AccessInput): Promise<void> {
  // A field the caller had no value for is left out, as a record read back has it.
  const known = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as AccessInput;
  const record: AccessRecord = { id: monotonicUlid(), timestamp: Date.now(), ...known };
  try {
    await vfs.appendAccessLog([record]);
  } catch (error) {
    logger.warn('access log write failed', { event: input.event, error: error instanceof Error ? error.message : String(error) });
  }
}
