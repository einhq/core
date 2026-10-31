import { useEffect, useState } from 'react';
import { execCommand } from '../signals/shell-client.ts';
import { shq } from '../lib/shquote.ts';
import type { NodeChildEntry } from '../lib/node-entry.ts';
import { GRID_NAME, THUMB_NAME } from '../lib/derivatives.ts';
import { fileUrl } from '../lib/file-url.ts';
import { COVER_LINK_NAME, type CoverImage, mediaCoverImage, runLimited } from '../lib/cover.ts';
import { NON_MEMBER_LINK_NAMES } from '@ein/paths';

export type AlbumEntry = {
  /** Directory name — the slug the path is built from, not what to show. */
  name: string;
  /** `attrs.name`, the album's own title; falls back to the directory name. */
  title: string;
  path: string;
  /** Whether the album's media lives under a `files/` subdir (structural hint from the listing). */
  hasFilesDir: boolean;
  /** attrs.origin — 'auto' for a staging suggestion. */
  origin?: string;
  modtime?: number;
  description?: string;
  labels?: string[];
  /** Stored album dates. Only auto albums carry them; see lib/album-dates.ts. */
  timeStart?: string;
  timeEnd?: string;
  /**
   * Auto-album summary, present only on `origin === 'auto'` entries; the full
   * per-signal breakdown is a separate per-album read.
   */
  locationPath?: string;
  /** The clusterer's own member count — trusted ahead of the cover loader's. */
  memberCount?: number;
  /** Some member is still waiting on the crawl; membership may still change. */
  provisional?: boolean;
  /** Renamed or hand-edited, so the clusterer leaves it alone. */
  pinned?: boolean;
  /** How confidently the clusterer grouped these, 0..1. */
  overall?: number;
  /** A run of days away from home, rolled up from its day-parts. */
  kind?: 'trip';
  /** Distinct days the members fall on. */
  days?: number;
  /**
   * Member count from the listing (`album list`), counted from child names; what sorts the grid by
   * size. The card shows useAlbumCover's count of media once it has one.
   */
  itemCount?: number;
  /** Cover thumbnail URL — loaded lazily per card via useAlbumCover, undefined until then. */
  coverUrl?: string;
};

type CoverInfo = { cover?: CoverImage; itemCount: number };

/**
 * What the cover loader actually needs. Callers that never listed the album —
 * a search hit, an auto-album card — have a path and nothing else.
 */
export type AlbumCoverRef = Pick<AlbumEntry, 'path' | 'hasFilesDir'>;

function isMediaEntry(entry: NodeChildEntry): boolean {
  if (entry.node.type !== 'file') return false;
  const mimetype = entry.node.attrs.mimetype || '';
  return mimetype.startsWith('image/') || mimetype.startsWith('video/');
}

/**
 * A member of the album that is not a file it holds itself.
 *
 * A file added to an album, or a staging suggestion's member, is a link rather than
 * a file the album holds, so links count as well as file children: every softlink except the
 * cover and the album's series neighbours is a member.
 */
function isLinkedMember(entry: NodeChildEntry): boolean {
  return Boolean(entry.node.props.softlink) && !NON_MEMBER_LINK_NAMES.includes(entry.name);
}

// Cover/count results persist for the session so re-entering a card's viewport
// (or navigating dashboard <-> albums) is instant and never refetches.
const coverCache = new Map<string, CoverInfo>();

/** Drop an album's cached cover so its card fetches again — after its `coverPhoto` link changed. */
export function forgetAlbumCover(albumPath: string): void {
  coverCache.delete(albumPath);
}

/**
 * Media sits under `<album>/files/` for imported albums and directly in the album
 * dir for flat ones. `hasFilesDir` says which, except when the caller never listed
 * the album — a search hit knows only a path — so a miss probes the other shape
 * rather than leaving the card blank. One extra `ls`, and only when the first came
 * up empty.
 */
async function fetchCover(album: AlbumCoverRef): Promise<CoverInfo> {
  const primary = await coverFrom(album.hasFilesDir ? `${album.path}/files` : album.path);
  if (primary.cover) return primary;

  const alternate = await coverFrom(album.hasFilesDir ? album.path : `${album.path}/files`);
  return alternate.cover ? alternate : primary;
}

async function coverFrom(dir: string): Promise<CoverInfo> {
  try {
    // -C: the cover probe needs the first media entry's own child names
    const children = await execCommand<NodeChildEntry[]>(`ls -lC ${shq(dir)}`);
    const media = children.filter(isMediaEntry);
    const itemCount = media.length + children.filter(isLinkedMember).length;

    // An explicit `coverPhoto` softlink (set by album set cover / import) wins.
    const coverTarget = children.find((c) => c.name === COVER_LINK_NAME)?.node.props.softlink;
    const firstMedia = media[0];

    // A softlink cover points outside this listing, so its derivatives take
    // their own probe; the first-media fallback already has its child names in
    // hand from `ls -lC`. A cover link that no longer resolves falls through to
    // the first picture rather than to a broken image.
    if (coverTarget) {
      const cover = await mediaCoverImage(coverTarget, GRID_NAME, THUMB_NAME);
      if (cover) return { cover, itemCount };
    }

    if (!firstMedia) {
      return { itemCount };
    }

    const coverPath = `${dir}/${firstMedia.name}`;
    const childNames = new Set((firstMedia.children ?? []).map((c) => c.name));
    const cover: CoverImage = childNames.has('thumbnails')
      ? { url: `${fileUrl(coverPath)}/thumbnails/${GRID_NAME}`, fallbackUrl: `${fileUrl(coverPath)}/thumbnails/${THUMB_NAME}` }
      : { url: fileUrl(coverPath) };

    return { cover, itemCount };
  } catch {
    return { itemCount: 0 };
  }
}

/**
 * Lazily load an album's cover thumbnail and media count. Pass `enabled` from a
 * viewport check (e.g. Mantine's useInViewport) so only visible cards fetch.
 * Result is cached for the session; once loaded it never refetches.
 */
export function useAlbumCover(
  album: AlbumCoverRef,
  enabled: boolean,
): { coverUrl?: string; coverFallbackUrl?: string; itemCount?: number; loaded: boolean } {
  const [data, setData] = useState<CoverInfo | undefined>(() => coverCache.get(album.path));
  const [shownPath, setShownPath] = useState(album.path);

  // Same re-seed the node cover needs, for the same reason: a caller that keeps
  // one card mounted while its album changes — the staging suggestion review —
  // would otherwise keep the first album's picture, because the state is seeded
  // once at mount and the effect below leaves a settled value alone.
  if (shownPath !== album.path) {
    setShownPath(album.path);
    setData(coverCache.get(album.path));
  }

  useEffect(() => {
    if (data || !enabled) return;
    let cancelled = false;
    runLimited(() => fetchCover(album)).then((info) => {
      coverCache.set(album.path, info);
      if (!cancelled) setData(info);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, album.path, album.hasFilesDir, data]);

  return {
    coverUrl: data?.cover?.url,
    coverFallbackUrl: data?.cover?.fallbackUrl,
    itemCount: data?.itemCount,
    loaded: data !== undefined,
  };
}
