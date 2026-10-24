import { batch, computed, signal } from '@preact/signals-react';
import type { NodeOwnership } from '@ein/api';
import { lightboxPathFromRoute, lightboxRoute } from '../lib/lightbox-route.ts';
import { mediaItemFrom } from '../lib/media-item.ts';
import { closeFullscreen, fullscreenPath, openFullscreen } from './surface.ts';

/** A media file as the grids and the lightbox show it. */
export type MediaItem = {
  id: string;
  name: string;
  type: 'photo' | 'video' | 'audio';
  mimetype: string;
  thumbnailUrl: string;
  fullUrl: string;
  /** Photo sizes for the lightbox `srcset`; empty when there are no derivatives. */
  srcSet: string;
  path: string;
  /**
   * Where the album being viewed links this file, when membership is a softlink
   * (it was added there, or the album is a staging suggestion). Absent when the
   * file lives in the list it is in.
   *
   * The item carries both identities because they are acted on differently:
   * everything that touches the picture — download, retime, the lightbox — wants
   * `path`, and only unfiling it wants this one.
   */
  memberPath?: string;
  /** Album-local stack size; present only on the selected front shown by that album. */
  stackCount?: number;
  /** Container whose manifest supplied `stackCount` and owns stack mutations. */
  stackAlbumPath?: string;
  /** A `thumbnails/` dir exists, so the derivative levels can be addressed by name. */
  hasDerivatives: boolean;
  /**
   * Seconds into the file where a search matched, when it matched a transcript chunk.
   *
   * Set only by a search result. The lightbox opens the player here instead of at the start,
   * because on an hour-long recording the answer to the query is a moment, not the file.
   */
  atSeconds?: number;
  /** Set only by a relevance-ranked search hit; drives the match badge. */
  score?: number;
  size?: number;
  birthtime?: number;
  modtime?: number;
  /**
   * The resolved capture wall clock, absent when the file has no date at all.
   *
   * Possibly partial — `1975`, `2004-03` — and possibly carrying an offset. Never render it with
   * `Date.parse` plus `toLocaleString`, which invents a day and an hour for the files that only
   * ever had a year.
   */
  takenAt?: string;
  /** The instant it sorts by, `YYYY-MM-DDTHH:MM:SSZ`. Only the map's cursor needs it. */
  takenAtUtc?: string;
  duration?: number;
  /** Stored raster dimensions — pre-rotation. Use `displayAspect()` to get the display frame. */
  width?: number;
  height?: number;
  /**
   * Pixel aspect ratio of that raster, present only on an anamorphic video (an AVCHD `.MTS`
   * stores a 1440x1080 raster of a 1920x1080 picture). Absent means square pixels.
   */
  sar?: number;
  /** Display rotation in degrees (0/90/180/270); 90 and 270 swap width and height. */
  angle?: number;
  /** Who may change the file, when the list it came from said: a search hit does. */
  ownership?: NodeOwnership;
  /**
   * It keeps its own sharing (`share-set --pin`), so a change to the album's does not reach it,
   * when the list it came from said: a search hit does.
   */
  pinned?: boolean;
};

/** A directory to navigate to from an album. */
export type DirectoryEntry = {
  /** Directory name — the slug the path is built from. */
  name: string;
  /** `attrs.name` where there is one; the directory name otherwise. */
  title: string;
  path: string;
  childCount: number;
  /** It keeps its own sharing, and everything in it with it. */
  pinned?: boolean;
};

/** The list the lightbox walks. */
export const albumMediaList = signal<MediaItem[]>([]);

/** Where in `albumMediaList` the lightbox is; -1 when it is closed. */
export const currentMediaIndex = signal<number>(-1);

/**
 * The media path a closing lightbox asks its source grid to reveal.
 *
 * A target expires: some lightboxes are opened from face tools or other views with no
 * matching grid, and carrying their path into a later page would cause a surprise jump.
 */
export const lightboxReturnPath = signal<string | null>(null);
let lightboxReturnTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

const requestLightboxReturn = (path: string) => {
  lightboxReturnPath.value = path;
  if (lightboxReturnTimer !== undefined) globalThis.clearTimeout(lightboxReturnTimer);
  lightboxReturnTimer = globalThis.setTimeout(() => {
    lightboxReturnTimer = undefined;
    if (lightboxReturnPath.value === path) lightboxReturnPath.value = null;
  }, 2000);
};

export const clearLightboxReturn = (path: string) => {
  if (lightboxReturnPath.value !== path) return;
  lightboxReturnPath.value = null;
  if (lightboxReturnTimer !== undefined) globalThis.clearTimeout(lightboxReturnTimer);
  lightboxReturnTimer = undefined;
};

export const currentMediaItem = computed(() => {
  const index = currentMediaIndex.value;
  const list = albumMediaList.value;
  if (index >= 0 && index < list.length) {
    return list[index];
  }
  return null;
});

export const isLightboxOpen = computed(() => currentMediaIndex.value >= 0);

export const hasNextMedia = computed(
  () => currentMediaIndex.value >= 0 && albumMediaList.value.length > 1,
);

export const hasPrevMedia = hasNextMedia;

/** Navigation is circular in both directions, for direct lightbox use and slideshows alike. */
export const nextMediaIndex = (index: number, length: number): number => length < 2 ? index : (index + 1) % length;
export const prevMediaIndex = (index: number, length: number): number => length < 2 ? index : (index - 1 + length) % length;

export const goToNextMedia = () => {
  if (hasNextMedia.value) {
    currentMediaIndex.value = nextMediaIndex(currentMediaIndex.value, albumMediaList.value.length);
  }
};

export const goToPrevMedia = () => {
  if (hasPrevMedia.value) {
    currentMediaIndex.value = prevMediaIndex(currentMediaIndex.value, albumMediaList.value.length);
  }
};

/**
 * The lightbox is a route, `/media/<path>`, shown full screen over the page that opened it; these signals are what it walks: the list it was opened from and
 * where in it. Set when it opens, and cleared when its route goes (`endLightbox`).
 */

/** The list holds only the file the route asked for: a reload or a link, not a grid. */
let lightboxAlone = false;

/** The list the page behind offers while it is up (`offerLightboxList`); empty when none does. */
let offeredList: MediaItem[] = [];

/**
 * Point the lightbox at an item of a list, the two signals in one write: between them the
 * current item would be the new list's item at the old index, and the route, which follows the
 * current item, would move there.
 */
const showList = (list: MediaItem[], index: number) =>
  batch(() => {
    albumMediaList.value = list;
    currentMediaIndex.value = index;
  });

/** Open the lightbox at one item of a list, which arrows and swipes then walk. */
export const openMediaAt = (index: number, mediaList: MediaItem[]) => {
  const item = mediaList[index];
  if (!item) return;
  showList(mediaList, index);
  lightboxAlone = false;
  openFullscreen(lightboxRoute(item.path));
};

/**
 * Show the file the lightbox's route names: from the list it was opened from when it is there,
 * then from the list the page behind offers, and alone otherwise — a reload or a shared link
 * over a page whose list has not loaded — until the page offers one.
 */
export const showLightboxPath = (path: string) => {
  if (currentMediaItem.peek()?.path === path) return;
  const index = albumMediaList.peek().findIndex((item) => item.path === path);
  if (index >= 0) {
    currentMediaIndex.value = index;
    return;
  }
  const offered = offeredList.findIndex((item) => item.path === path);
  lightboxAlone = offered < 0;
  if (offered >= 0) showList(offeredList, offered);
  else showList([mediaItemFrom({ path })], 0);
};

/**
 * A page's loaded list, kept while the page is up, for a lightbox opened alone over it: when the
 * file it shows is in the list — now, or once its route opens — the lightbox walks that list from
 * there, as if it had been opened from the grid. The page offers an empty list when it goes.
 */
export const offerLightboxList = (items: MediaItem[]) => {
  offeredList = items;
  if (!lightboxAlone || currentMediaIndex.peek() < 0) return;
  const index = items.findIndex((item) => item.path === currentMediaItem.peek()?.path);
  if (index < 0) return;
  lightboxAlone = false;
  showList(items, index);
};

/**
 * The lightbox's route has closed or is closing: nothing is open. With `returnToGrid` the grid it
 * was opened from shows where it was left, and the picture shrinks back into its tile.
 */
export const endLightbox = (returnToGrid: boolean) => {
  if (currentMediaIndex.peek() < 0) return;
  const path = currentMediaItem.peek()?.path;
  if (returnToGrid && path) requestLightboxReturn(path);
  else clearLightboxReturnTarget();
  currentMediaIndex.value = -1;
  lightboxAlone = false;
};

const clearLightboxReturnTarget = () => {
  lightboxReturnPath.value = null;
  if (lightboxReturnTimer !== undefined) globalThis.clearTimeout(lightboxReturnTimer);
  lightboxReturnTimer = undefined;
};

/** Close the full-screen lightbox, if it is the route shown full screen. */
const closeLightboxRoute = () => {
  if (lightboxPathFromRoute(fullscreenPath.peek()) !== undefined) closeFullscreen();
};

/** Close for deletion, another modal, or route navigation where there is no grid to restore. */
export const closeLightboxWithoutReturn = () => {
  endLightbox(false);
  closeLightboxRoute();
};

/**
 * Set when removed media came back — the Undo of a delete — naming the paths. A list that dropped
 * them reloads on it, as a page reloads on `uploadBatchDone`.
 */
export const mediaRestored = signal<{ paths: string[]; at: number } | null>(null);
