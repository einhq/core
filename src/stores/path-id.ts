/**
 * Node ids for stores that mirror a tree kept elsewhere (a host directory, an
 * SFTP server): the base64 of the path within the mount. A lookup needs no
 * index, at the cost of the id changing when the node moves.
 */

import { decodeBase64, encodeBase64 } from '@std/encoding';
import type { NodeId } from '../vfs/mod.ts';

/** The id for a path relative to the mount root (`''`, `/` and `a/b` or `/a/b` all work) */
export function encodePathId(relativePath: string): NodeId {
  // One leading slash, so the same entry always gets the same id whichever
  // code path produced the relative path
  const normalized = relativePath === '' || relativePath === '/' ? '/' : relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
  return encodeBase64(new TextEncoder().encode(normalized));
}

/**
 * The path an id stands for, or null when it is not one of ours. Ids from
 * other stores (ULIDs) are asked about too — a store without batch lookups is
 * probed with every foreign id — and decode to bytes that are not a path, so
 * they are turned away here rather than looked up.
 */
export function decodePathId(id: NodeId): string | null {
  try {
    const path = new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(id));
    return path.startsWith('/') && !path.includes('\0') ? path : null;
  } catch {
    return null;
  }
}
