import { signal } from '@preact/signals-react';

/**
 * Cache-busting tokens for the derivatives of a given file.
 *
 * Rotating or mirroring a file rewrites its renditions in place — same URLs, new bytes.
 * The server gives renditions a freshness lifetime (`Cache-Control`), which is what stops
 * every grid tile and every hover preview costing a round trip; the cost is that the
 * session which *caused* a regeneration would otherwise keep seeing the old picture until
 * that lifetime ran out. So the side that knows a file changed says so, and every URL for
 * it gains a `?v=`.
 *
 * Module-level, as `lib/aspect-cache.ts` is, because the lightbox and the grid behind it
 * need the same answer about the same path. Unlike that one it is a signal, because a bump has to re-render tiles and
 * nothing else would. One signal for every path is fine — bumps happen on a rotate, not
 * on scroll.
 */
const versions = signal<Record<string, number>>({});

/** Note that `path`'s derivatives have been regenerated. */
export function bumpDerivativeVersion(path: string): void {
  versions.value = { ...versions.value, [path]: (versions.value[path] ?? 0) + 1 };
}

/**
 * Current token for a path, 0 when its derivatives have not changed this session.
 *
 * Reads the signal, so a component calling this during render subscribes to it.
 */
export function versionOf(path: string): number {
  return versions.value[path] ?? 0;
}

/** Append the token to a URL. A token of 0 leaves the URL untouched, so nothing is busted by default. */
export function bust(url: string, token: number): string {
  return token === 0 || !url ? url : `${url}${url.includes('?') ? '&' : '?'}v=${token}`;
}

/** `bust` across every candidate of a srcset, keeping the `w` descriptors. */
export function bustSrcSet(srcSet: string | undefined, token: number): string | undefined {
  if (!srcSet || token === 0) return srcSet;

  return srcSet
    .split(', ')
    .map((entry) => {
      const [url, descriptor] = entry.split(' ');
      return `${bust(url, token)} ${descriptor}`;
    })
    .join(', ');
}
