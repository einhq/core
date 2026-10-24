import { RegistryIf, ResourceOptions, ResourceSeekMode } from '../types.ts';
import type { LogStat } from '../../lib/api/streams.ts';
export type { LogStat } from '../../lib/api/streams.ts';

export type LogResourceOptions = ResourceOptions & {
  retention?: string;
  routingKeys?: string[];
};

/** Retention policy for log entries. Duration strings are passed to TimescaleDB as intervals. Count strings (e.g. '100 entries') cap the number of entries per log. */
export type RetentionPolicy =
  | 'forever'
  | '1 hour'
  | '6 hour'
  | '12 hour'
  | '1 day'
  | '7 day'
  | '14 day'
  | '30 day'
  | '60 day'
  | '90 day'
  | '180 day'
  | '365 day'
  | '1 year'
  | '2 year'
  | '5 year'
  | `${number} entries`;

export type ParsedRetention =
  | { type: 'forever' }
  | { type: 'duration'; interval: string }
  | { type: 'count'; limit: number };

const COUNT_RE = /^(\d+)\s+entries$/;

/** Parse a retention string into a structured representation. */
export function parseRetention(retention: string): ParsedRetention {
  if (!retention || retention === 'forever') {
    return { type: 'forever' };
  }

  const m = retention.match(COUNT_RE);
  if (m) {
    const limit = parseInt(m[1], 10);
    if (limit < 1) {
      throw new Error(`invalid retention count: ${retention}`);
    }
    return { type: 'count', limit };
  }

  return { type: 'duration', interval: retention };
}

/** Numeric identifier for a log entry, used for cursor-based reads. */
export type LogEntryId = number;

/** A single log entry with its metadata and payload. */
export interface LogEntry {
  /** Unique sequential identifier for this entry. */
  id: LogEntryId;
  /** Timestamp when the entry was written. */
  createdAt: Date;
  /** Arbitrary JSON payload stored in the entry. */
  data: unknown;
}

/** Low-level I/O operations for reading and writing log entries. */
export interface LogIO {
  /** Append a data payload to the log, returning the new entry's id. `createdAt` backdates the entry (defaults to now) — used by imports of historical series. */
  append(data: unknown, createdAt?: Date): Promise<LogEntryId>;
  /** Read up to `limit` entries after `startId`. Blocks if signal is provided and no entries are available. */
  read(limit: number, startId?: LogEntryId, signal?: AbortSignal): Promise<LogEntry[] | null>;
  /** Seek to a position in the log, returning the entry id at that position. */
  seek(offset: number, whence: ResourceSeekMode, startId?: LogEntryId): Promise<LogEntryId>;
}

/** Registry interface for managing named logs backed by a storage engine. */
export interface LogRegistryIf extends RegistryIf<LogResourceOptions, LogStat> {}
