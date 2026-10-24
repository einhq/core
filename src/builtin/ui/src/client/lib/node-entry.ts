/**
 * Shapes and predicates for a `ls -l` listing, shared by every hook that reads
 * one. Not tied to albums: people, locations, docs and tracks all list nodes.
 */

import type { DirectoryEntry } from '../signals/album.ts';

/**
 * Node child entry returned by ls -l with JSON_OUTPUT=1
 *
 * `childCount` is always there; `children` only with `ls -lC`, since naming an
 * entry's own children is a lookup per entry.
 */
export type NodeChildEntry = {
  node: {
    id: string;
    type: string;
    props: {
      uid: number;
      gid: number;
      mode: number;
      birthtime: { uid: number; timestamp: number | string };
      changetime: { uid: number; timestamp: number | string };
      modtime: { uid: number; timestamp: number | string };
      count: number;
      /** Target path, present only on softlink nodes (e.g. an album coverPhoto). */
      softlink?: string;
      /** Extra grants beyond the mode bits; `ls -l` marks a node that has any with `+`. */
      acl?: { mode: number; uid?: number; gid?: number }[];
      /** Where a file's bytes live; only files carry it. */
      tier?: 'disk' | 'volatile' | 'db';
    };
    attrs: {
      name?: string;
      mimetype?: string;
      size?: number;
      sha256?: string;
      /** Set on a rendition or version: the file it was made from. Such a file has no derivatives of its own. */
      sourceId?: string;
      /** Present on album nodes; 'auto' marks a machine-generated auto album. */
      origin?: string;
      description?: string;
      /** `label add` writes these; /tags/<label>/ mirrors them as softlinks. */
      labels?: string[];
      /** When an album happened. See lib/album-dates.ts for the two spellings. */
      timeStart?: string;
      timeEnd?: string;
      autoAlbum?: { timeStart?: string; timeEnd?: string };
      /** Hot scalars `exif-extract` promotes onto the file node itself. Stored raster. */
      width?: number;
      height?: number;
      duration?: number;
      angle?: number;
      /** Pixel aspect ratio of that raster; only an anamorphic video carries one. */
      sar?: number;
      /** Set by `share-set --pin`: the node keeps its own sharing. */
      accessPinned?: boolean;
    };
  };
  name: string;
  childCount: number;
  children?: Array<{ id: string; name: string }>;
};

// Postgres returns node timestamps as strings like "1783245659707.000000";
// coerce to a millisecond number (undefined if absent/unparseable).
export function toMillis(ts?: number | string): number | undefined {
  if (ts === undefined || ts === null) return undefined;
  const n = Number(ts);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

export function transformToDirectory(entry: NodeChildEntry, albumPath: string): DirectoryEntry {
  return {
    name: entry.name,
    title: entry.node.attrs.name || entry.name,
    path: `${albumPath}/${entry.name}`,
    childCount: entry.childCount,
    ...(entry.node.attrs.accessPinned === true ? { pinned: true } : {}),
  };
}

export function isMediaFile(entry: NodeChildEntry): boolean {
  if (entry.node.type !== 'file') return false;
  const mimetype = entry.node.attrs.mimetype || '';
  return (
    mimetype.startsWith('image/') ||
    mimetype.startsWith('video/') ||
    mimetype.startsWith('audio/')
  );
}

/**
 * Children that hold machine-written facts about the node, not content.
 *
 * `metadata/` is where extracted facts and their embeddings live (a file's EXIF,
 * transcript, extracted text). It is a real directory, so without this it renders
 * as a folder card inviting someone to click into a node's own bookkeeping.
 */
const HIDDEN_CHILD_NAMES = new Set(['metadata']);

export function isDirectory(entry: NodeChildEntry): boolean {
  if (HIDDEN_CHILD_NAMES.has(entry.name)) return false;
  return entry.node.type === 'directory' || entry.node.type === 'album';
}

const EXT_TYPE: Record<string, 'photo' | 'video' | 'audio'> = {
  jpg: 'photo',
  jpeg: 'photo',
  png: 'photo',
  gif: 'photo',
  webp: 'photo',
  avif: 'photo',
  heic: 'photo',
  heif: 'photo',
  tif: 'photo',
  tiff: 'photo',
  bmp: 'photo',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  mkv: 'video',
  avi: 'video',
  m4v: 'video',
  '3gp': 'video',
  mp3: 'audio',
  m4a: 'audio',
  wav: 'audio',
  flac: 'audio',
  aac: 'audio',
  ogg: 'audio',
  opus: 'audio',
};

/** Media kind guessed from the file extension, for callers with no node attrs in hand. */
export function typeFromPath(path: string): 'photo' | 'video' | 'audio' | undefined {
  const ext = path.split('.').pop()?.toLowerCase();
  return ext ? EXT_TYPE[ext] : undefined;
}

/**
 * Whether the file has renditions of its own. A rendition itself carries
 * `sourceId` and no children, and asking for `<file>/thumbnails/…` under it is
 * a 404; the file's own bytes are what there is, and a browser shows an AVIF or
 * a JPEG directly.
 */
export const hasRenditions = (entry: NodeChildEntry): boolean => entry.node.attrs.sourceId === undefined && entry.childCount > 0;
