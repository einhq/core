/**
 * Compact wire format for a complete materialized media layout index.
 *
 * A large album or subject collection repeats the same long directory and
 * mimetype thousands of times. Dictionaries remove those repetitions;
 * fixed-position rows remove per-field JSON keys. The UI has a deliberately
 * duplicated decoder because the browser shell cannot import core command code.
 */

import { basename, dirname } from '@std/path';
import type { LayoutIndexItem, LayoutIndexRow, LayoutMediaKind, SearchLayoutIndex, SearchLayoutResponse } from '../api/search.ts';
export type { LayoutIndexItem, LayoutIndexRow, LayoutMediaKind, SearchLayoutIndex, SearchLayoutResponse } from '../api/search.ts';

/**
 * Keep a complete layout comfortably below the API shell's 4 MiB capture cap.
 *
 * The item ceiling limits server work, not wire bytes: real filenames, display
 * names and directory paths can be much longer than the representative corpus
 * in the codec test. The client already treats `truncated` as an instruction to
 * use cursor paging, so an over-budget layout is represented by that small
 * response instead of being allowed to fail in the transport.
 */
export const SEARCH_LAYOUT_MAX_JSON_BYTES = 2 * 1024 * 1024;

const EMPTY_LAYOUT: SearchLayoutIndex = { directories: [], mimetypes: [], ownerships: [], items: [] };

const truncatedResponse = (): SearchLayoutResponse => ({
  truncated: true,
  cursor: null,
  offset: 0,
  layout: EMPTY_LAYOUT,
});

const KIND_CODE: Record<LayoutMediaKind, number> = { photo: 0, video: 1, audio: 2 };

export function encodeLayoutIndex(items: readonly LayoutIndexItem[]): SearchLayoutIndex {
  const directories: string[] = [];
  const directoryIndexes = new Map<string, number>();
  const mimetypes: string[] = [];
  const mimetypeIndexes = new Map<string, number>();
  const ownershipKeys: string[] = [];
  const ownershipIndexes = new Map<string, number>();

  const intern = (value: string, values: string[], indexes: Map<string, number>): number => {
    const known = indexes.get(value);
    if (known !== undefined) return known;
    const index = values.length;
    values.push(value);
    indexes.set(value, index);
    return index;
  };

  const rows = items.map((item): LayoutIndexRow => {
    const pathName = basename(item.path);
    const memberName = item.memberPath ? basename(item.memberPath) : '';
    return [
      intern(dirname(item.path), directories, directoryIndexes),
      pathName,
      item.memberPath ? intern(dirname(item.memberPath), directories, directoryIndexes) : -1,
      memberName,
      item.name === pathName ? '' : item.name,
      KIND_CODE[item.kind],
      intern(item.mimetype ?? '', mimetypes, mimetypeIndexes),
      item.takenAt ?? '',
      item.width ?? 0,
      item.height ?? 0,
      item.angle ?? 0,
      item.duration ?? 0,
      item.stackCount ?? 0,
      item.sar ?? 0,
      intern(JSON.stringify(item.ownership), ownershipKeys, ownershipIndexes),
      item.pinned ? 1 : 0,
    ];
  });

  const index: SearchLayoutIndex = { directories, mimetypes, ownerships: ownershipKeys.map((key) => JSON.parse(key)), items: rows };
  // Every item carries it or none does: the caller asked for it or did not.
  if (items.some((item) => item.hasDerivatives !== undefined)) index.derivatives = items.map((item) => item.hasDerivatives ? 1 : 0);
  return index;
}

/** Build a complete response, or the paged-fallback signal when it cannot fit. */
export function buildLayoutResponse(items: readonly LayoutIndexItem[], sourceTruncated: boolean): SearchLayoutResponse {
  if (sourceTruncated) return truncatedResponse();

  const response: SearchLayoutResponse = {
    truncated: false,
    cursor: null,
    offset: 0,
    layout: encodeLayoutIndex(items),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(response)).byteLength;
  return bytes <= SEARCH_LAYOUT_MAX_JSON_BYTES ? response : truncatedResponse();
}
