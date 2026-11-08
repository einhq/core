/**
 * Range and bucketed reads over entries in memory, the way PostgreSQL's (`pg-log-registry.ts`)
 * answer them: the memory registry's, and what its conformance tests hold both to.
 */

import type { LogBucket, LogBucketQuery, LogEntry, LogRange } from './types.ts';

/** The value an entry gives a bucketed read: a number, or true and false as 1 and 0. */
const numericAt = (data: unknown, field: string[] = []): number | undefined => {
  let value = data;
  for (const step of field) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[step];
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return undefined;
};

/** Minutes `timeZone` is ahead of UTC at `ms`. */
const offsetMinutes = (ms: number, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((local - Math.floor(ms / 1000) * 1000) / 60_000);
};

/** Where intervals are counted from: TimescaleDB's `time_bucket`'s, a Monday, so weeks start on one. */
const ORIGIN = Date.UTC(2000, 0, 3);

const floorTo = (ms: number, bucketMs: number): number => ORIGIN + Math.floor((ms - ORIGIN) / bucketMs) * bucketMs;

/** Where the interval holding `ms` starts. */
const bucketStart = (ms: number, bucketMs: number, timeZone?: string): number => {
  if (!timeZone || timeZone === 'UTC') return floorTo(ms, bucketMs);
  const shift = offsetMinutes(ms, timeZone) * 60_000;
  const local = floorTo(ms + shift, bucketMs);
  return local - offsetMinutes(local - shift, timeZone) * 60_000;
};

const inRange = (entry: LogEntry, range: Omit<LogRange, 'limit'>): boolean => {
  const at = entry.createdAt.getTime();
  return (!range.since || at >= range.since.getTime()) && (!range.until || at < range.until.getTime());
};

/** Entries by their time, then by their id, as both registries order them. */
const byTime = (a: LogEntry, b: LogEntry): number => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id;

export const rangeOf = (entries: LogEntry[], range: LogRange): LogEntry[] => {
  const found = entries.filter((entry) => inRange(entry, range)).sort(byTime);
  return range.limit === undefined ? found : found.slice(Math.max(0, found.length - range.limit));
};

export const bucketsOf = (entries: LogEntry[], query: LogBucketQuery): LogBucket[] => {
  const bucketMs = query.bucketSeconds * 1000;
  const groups = new Map<number, LogEntry[]>();
  for (const entry of entries.filter((entry) => inRange(entry, query)).sort(byTime)) {
    const at = bucketStart(entry.createdAt.getTime(), bucketMs, query.timeZone);
    groups.set(at, [...(groups.get(at) ?? []), entry]);
  }
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([at, group]) => {
    const values = group.map((entry) => numericAt(entry.data, query.field)).filter((value): value is number => value !== undefined);
    let value: number | null;
    switch (query.aggregate) {
      case 'count':
        value = group.length;
        break;
      case 'avg':
        value = values.length ? values.reduce((sum, each) => sum + each, 0) / values.length : null;
        break;
      case 'sum':
        value = values.length ? values.reduce((sum, each) => sum + each, 0) : null;
        break;
      case 'min':
        value = values.length ? Math.min(...values) : null;
        break;
      case 'max':
        value = values.length ? Math.max(...values) : null;
        break;
      case 'first':
        value = values[0] ?? null;
        break;
      case 'last':
        value = values.at(-1) ?? null;
        break;
    }
    return { at: new Date(at), value, count: group.length };
  });
};
