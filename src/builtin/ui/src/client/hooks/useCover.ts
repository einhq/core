import { useEffect, useState } from 'react';
import { type CoverImage, coverLinkImage, runLimited } from '../lib/cover.ts';
import { THUMB_NAME } from '../lib/derivatives.ts';

// Results persist for the session: re-entering a card's viewport, or navigating
// away and back, is then instant and never refetches. Keyed by rendition as well as
// path — an 80px avatar and a card banner want different renditions of the same
// picture, and a shared key would hand one the other's URL.
const cache = new Map<string, CoverImage | null>();

// Hooks currently showing a node's cover, so a change made on this page — "Set as
// cover" in the album grid — reaches the header avatar without a reload.
const watchers = new Map<string, Set<() => void>>();

/**
 * Drop every cached rendition of `ownerPath`'s cover and make any mounted
 * `useCover` for it fetch again. Called after the `coverPhoto` link changed.
 */
export function forgetCover(ownerPath: string): void {
  for (const key of [...cache.keys()]) {
    if (key.endsWith(`\0${ownerPath}`)) cache.delete(key);
  }
  for (const notify of watchers.get(ownerPath) ?? []) notify();
}

export type UseCoverOptions = {
  /** Rendition to draw. Defaults to the square `thumb`, which is what avatars want. */
  rendition?: string;
  /** Rendition to try when the file has no `rendition`. */
  fallbackRendition?: string;
  /** Draw the whole photo a face-crop cover was cut from — for a banner, where a crop is too small. */
  sourcePhoto?: boolean;
};

/**
 * The cover image of any node that has one — a person, a location, an album.
 *
 * Pass `enabled` from a viewport check (Mantine's useInViewport) so only visible
 * cards fetch. `undefined` means "no cover", which is the normal case: the
 * caller keeps whatever placeholder it draws.
 */
export function useCover(
  ownerPath: string,
  enabled = true,
  { rendition = THUMB_NAME, fallbackRendition, sourcePhoto = false }: UseCoverOptions = {},
): { coverUrl?: string; coverFallbackUrl?: string; loaded: boolean } {
  const key = `${rendition}${sourcePhoto ? '+photo' : ''}\0${ownerPath}`;
  const [cover, setCover] = useState<CoverImage | null | undefined>(() => cache.get(key));
  const [shownKey, setShownKey] = useState(key);

  // A route that swaps its node without remounting — /albums/:id, which is what
  // the random-album button drives — would otherwise keep drawing the previous
  // album's cover forever: the state is seeded once at mount, and the effect
  // below leaves a settled value alone. Re-seeding during the render that
  // changed the key swaps the picture in the same paint as the title and the
  // breadcrumb, rather than a frame later.
  if (shownKey !== key) {
    setShownKey(key);
    setCover(cache.get(key));
  }

  useEffect(() => {
    if (!ownerPath) return;
    const refetch = () => setCover(undefined);
    const set = watchers.get(ownerPath) ?? new Set();
    set.add(refetch);
    watchers.set(ownerPath, set);
    return () => {
      set.delete(refetch);
      if (set.size === 0) watchers.delete(ownerPath);
    };
  }, [ownerPath]);

  useEffect(() => {
    if (cover !== undefined || !enabled || !ownerPath) return;
    let cancelled = false;

    runLimited(() => coverLinkImage(ownerPath, rendition, fallbackRendition, sourcePhoto)).then((found) => {
      cache.set(key, found ?? null);
      if (!cancelled) setCover(found ?? null);
    }).catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [key, ownerPath, enabled, rendition, fallbackRendition, sourcePhoto, cover]);

  return { coverUrl: cover?.url, coverFallbackUrl: cover?.fallbackUrl, loaded: cover !== undefined };
}
