import { useMemo } from 'react';
import type { LogFollowEntry } from '../signals/shell-client.ts';
import { useLogFollow } from './useLogFollow.ts';

/** One entry of the system log, /var/logs/system. */
export type LogLine = {
  id: number;
  at: number;
  level: string;
  name: string;
  message: string;
  /** The context the logger wrote beside the message, as `key=value` pairs; absent when none. */
  extra?: string;
};

/** What the logger writes of every entry; the rest of an entry is its context. */
const ENTRY_KEYS = new Set(['level', 'name', 'message', 'timestamp']);

/**
 * How many lines are kept. A busy instance writes several lines per pipeline
 * instance, so an unbounded buffer on a page left open is a slow leak; this is
 * far more than fits on a screen and still bounded.
 */
const MAX_LINES = 500;

/** History requested on subscribe, so the panel opens with context rather than blank. */
const TAIL = 200;

const toLine = (entry: LogFollowEntry): LogLine => {
  const data = (entry.data ?? {}) as Record<string, unknown>;
  const stamped = Date.parse(String(data.timestamp ?? entry.createdAt));

  return {
    id: entry.id,
    at: Number.isFinite(stamped) ? stamped : Date.now(),
    level: String(data.level ?? 'INFO'),
    name: String(data.name ?? '?'),
    message: String(data.message ?? ''),
    extra: Object.entries(data)
      .filter(([key]) => !ENTRY_KEYS.has(key))
      .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
      .join(' ') || undefined,
  };
};

/** A live tail of the system log, as lines; `useLogFollow` underneath. */
export function useLogTail(path: string, paused = false): { lines: LogLine[]; connected: boolean; clear: () => void } {
  const { entries, connected, clear } = useLogFollow(path, { tail: TAIL, keep: MAX_LINES, paused });
  const lines = useMemo(() => entries.map(toLine), [entries]);
  return { lines, connected, clear };
}
