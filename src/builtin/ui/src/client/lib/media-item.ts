/**
 * Building a lightbox-ready MediaItem from a bare file reference.
 *
 * The album grid gets its items from `ls -lC`, which names each file's children and so can
 * *verify* a `thumbnails/` dir exists. Everything else that opens the lightbox — a search
 * hit, a face's source photo — has only a path, so the derivative URLs are assumed present
 * rather than checked. That is deliberate and safe: MediaThumbnail falls back to a
 * placeholder when a thumbnail 404s, and the lightbox falls back to the original.
 */

import type { NodeOwnership } from '@ein/api';
import type { MediaItem } from '../signals/album.ts';
import { displayUrl, imageSrcSet, thumbnailUrl } from './derivatives.ts';
import { displayDims } from './justified-layout.ts';

export type MediaRef = {
  path: string;
  /** The softlink that makes this a member of the album it was listed from, if any. */
  memberPath?: string;
  stackCount?: number;
  /** Seconds into the file where a search matched, from a transcript chunk hit. */
  atSeconds?: number;
  score?: number;
  stackAlbumPath?: string;
  name?: string;
  mimetype?: string;
  type?: MediaItem['type'];
  /** Stored raster dimensions — pre-rotation; the grid needs them for the tile aspect. */
  width?: number;
  height?: number;
  /** Pixel aspect ratio of that raster; only an anamorphic video has one. */
  sar?: number;
  angle?: number;
  duration?: number;
  /** Effective capture time. A search hit has one; a bare path does not. */
  takenAt?: string;
  /**
   * Whether a `thumbnails/` directory exists under the file. Defaults to true,
   * which every listed original satisfies; a rendition — a face crop, a frozen
   * version — has none, and its own bytes are what a browser is shown.
   */
  hasDerivatives?: boolean;
  /** Who may change the file; a search hit carries it. */
  ownership?: NodeOwnership;
  /** It keeps its own sharing; a search hit says so. */
  pinned?: boolean;
};

const typeOf = (mimetype: string): MediaItem['type'] => {
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'photo';
};

export function mediaItemFrom(ref: MediaRef): MediaItem {
  const mimetype = ref.mimetype ?? 'application/octet-stream';
  const type = ref.type ?? typeOf(mimetype);
  // The picture's own size, when known, so the URLs ask only for the sizes a small source has.
  const dims = displayDims(ref);
  const hasDerivatives = ref.hasDerivatives ?? true;

  return {
    id: ref.path,
    name: ref.name ?? ref.path.split('/').pop() ?? ref.path,
    type,
    mimetype,
    thumbnailUrl: thumbnailUrl(ref.path, hasDerivatives),
    fullUrl: displayUrl(ref.path, type, hasDerivatives, dims),
    srcSet: imageSrcSet(ref.path, type, hasDerivatives, dims),
    path: ref.path,
    memberPath: ref.memberPath,
    stackCount: ref.stackCount,
    stackAlbumPath: ref.stackAlbumPath,
    hasDerivatives,
    width: ref.width,
    height: ref.height,
    sar: ref.sar,
    angle: ref.angle,
    duration: ref.duration,
    takenAt: ref.takenAt,
    atSeconds: ref.atSeconds,
    score: ref.score,
    ownership: ref.ownership,
    pinned: ref.pinned,
  };
}
