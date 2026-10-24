/**
 * Filter vocabulary shared by `search` and `facets`.
 *
 * Kinds are *content* kinds (what the user thinks they are looking for), not
 * provider names. The vocabulary itself lives in `lib/kinds` — the pipeline
 * parser and the metrics sampler need to name a kind and must not import a
 * command — and is re-exported here so search's imports stay in one place.
 */

import { isFileKind, type Kind } from '../kinds/mod.ts';
import type { AttrCondition, AttrRef } from '../../vfs/query.ts';
import type { NodeType } from '../../vfs/node.ts';

export { FILE_KINDS, isFileKind, isKind, type Kind, kindConditions, MEDIA_KIND_PREFIX, MEDIA_KINDS, NOT_DERIVED } from '../kinds/mod.ts';

/**
 * Whether every kind asked for has no capture time of its own: only files do.
 *
 * Such a set is not absent from a time-ordered query by accident — `orderBy` excludes rows missing
 * the ordering attr, so asking the timeline driver for one returns nothing at all. `mod.ts` sorts a
 * kind set made only of these by name by default, and pages it on id under a time sort; see the
 * `timeless` branch there.
 */
export const isTimeless = (kinds: Kind[]): boolean => kinds.length > 0 && kinds.every((kind) => !isFileKind(kind));

/**
 * The **wall clock** a file was captured at: `takenAt`, a possibly-partial capture time
 * carrying an offset when one is known (`lib/capture-time`).
 *
 * This is the range and facet attr. `--from 1995 --to 2001` and the year facet are questions
 * about what the calendar said where the photograph was taken, not about an instant — a
 * midsummer evening in Stockholm belongs to the year the photographer would name it, whatever
 * UTC thought at the time.
 */
export const TAKEN_AT: AttrRef = 'takenAt';

/**
 * The **instant**: `takenAtUtc`, always a complete `YYYY-MM-DDTHH:MM:SSZ`.
 *
 * This is the ordering and cursor attr, and it is a separate attr rather than a computed form
 * of the one above for two reasons. Ordering on wall clocks interleaves timezones wrongly — a
 * Tokyo noon sorts after a Stockholm breakfast that happened four hours later — and a partial
 * value has no instant at all until something decides that `1975` means the start of 1975.
 * Being fixed width, it byte-sorts exactly as an epoch integer would, which is what lets the
 * text-only comparisons in `vfs/query.ts` and the PostgreSQL expression indexes serve it
 * unchanged.
 */
export const TAKEN_AT_UTC: AttrRef = 'takenAtUtc';

const DOCUMENT_MIMETYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
  'application/rtf',
  'text/plain',
  'text/markdown',
  'text/html',
];

/**
 * A node's content kind: a file's by its mimetype (none for a file that is no media or
 * document), anything else's its node type.
 */
export const classify = (type: string, mimetype: string | undefined): Kind | undefined => {
  if (type !== 'file') return type;

  const mime = mimetype ?? '';
  if (mime.startsWith('image/')) return 'photo';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (DOCUMENT_MIMETYPES.includes(mime)) return 'document';
  return undefined;
};

/** Node types a kind set can possibly match, for narrowing a store query. */
export const kindNodeTypes = (kinds: Kind[]): NodeType[] => [...new Set(kinds.map((kind) => isFileKind(kind) ? 'file' : kind))];

/**
 * Conditions for a time window. `to` is exclusive and both bounds accept
 * partial dates, so `--from 1995 --to 2001` is the whole span 1995-2000.
 *
 * These are lexicographic comparisons on the ISO string, i.e. local wall-clock
 * rather than an absolute instant — which is what a year slider means.
 */
export const timeConditions = (from?: string, to?: string): AttrCondition[] => {
  const conditions: AttrCondition[] = [];
  if (from !== undefined) conditions.push({ ref: TAKEN_AT, op: 'gte', value: from });
  if (to !== undefined) conditions.push({ ref: TAKEN_AT, op: 'lt', value: to });
  return conditions;
};

/**
 * The date-bound vocabulary is `lib/capture-time`'s, because a bound and a stored capture time
 * have to agree about what a partial value means. Re-exported under search's names for it.
 */
export { lowerBound as parseDateBound, upperBoundExclusive as exclusiveUpperBound } from '../capture-time/mod.ts';
