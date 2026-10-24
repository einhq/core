import { signal } from '@preact/signals-react';

/**
 * Which video tile, anywhere on the page, is allowed to play its hover-preview clip.
 *
 * Exactly one at a time, and the state is module-level rather than per-grid because a
 * page routinely has several grids: `MediaTimeline` renders one `MediaGrid` per date
 * bucket, so two or three are on screen at once and each would otherwise pick its own
 * tile to play. On a phone that is three simultaneous downloads and decodes for a screen
 * the reader is scrolling past.
 *
 * Two ways in, one for each kind of pointer:
 *
 * - **Hover** (`requestPreview`/`releasePreview`) where there is a pointer to hover with.
 * - **Visibility** (`observeForPreview`) where there is not — a touch screen has no hover
 *   state at all, so the clip has to start on its own. The most-visible tile wins.
 */
export const activePreview = signal<string | null>(null);

/**
 * How much of a tile must be on screen before it plays on a touch device.
 *
 * Well above half: the point is to preview what the reader has stopped on, and a lower
 * bar makes the choice flip between two tiles while a row is still scrolling past.
 */
const VISIBLE_ENOUGH = 0.6;

/**
 * Paths whose clip came back 404 — a video the backfill has not reached yet.
 *
 * A plain module Set, like `lib/aspect-cache.ts`: nothing renders off it directly, and a
 * tile reads it while deciding whether it can preview at all. Remembering the miss is
 * what stops a grid re-requesting a rendition that does not exist every time the pointer
 * crosses the same tile.
 */
const missing = new Set<string>();

/** Visible fraction per observed tile, maintained by the shared observer below. */
const ratios = new Map<string, number>();

let observer: IntersectionObserver | undefined;

/** Whether the pointer can hover. A touch screen reports `(hover: none)`. */
export function pointerCanHover(): boolean {
  return globalThis.matchMedia?.('(hover: hover)').matches ?? false;
}

/**
 * Whether the reader asked for less motion.
 *
 * The theme handles reduced motion as one override in `theme.css`, but an autoplaying
 * clip is not a CSS transition, so it has to be gated in script.
 */
function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

export function markPreviewMissing(path: string): void {
  missing.add(path);
}

export function hasPreview(path: string): boolean {
  return !missing.has(path);
}

/** The pointer settled on a tile. */
export function requestPreview(path: string): void {
  if (prefersReducedMotion() || missing.has(path)) return;
  activePreview.value = path;
}

/** The pointer left. Clears only if this path is still the one playing. */
export function releasePreview(path: string): void {
  if (activePreview.value === path) activePreview.value = null;
}

/** Pick the most-visible observed tile, or none if nothing is visible enough. */
function chooseMostVisible(): void {
  let best: string | null = null;
  let bestRatio = 0;

  for (const [path, ratio] of ratios) {
    if (ratio > bestRatio && !missing.has(path)) {
      best = path;
      bestRatio = ratio;
    }
  }

  // The winner still has to clear the bar — mid-scroll every tile is partly visible, and
  // "most visible of a bad lot" is how a preview ends up flickering between two rows.
  if (bestRatio < VISIBLE_ENOUGH) best = null;

  if (activePreview.value !== best) activePreview.value = best;
}

/**
 * Register a tile so it can autoplay when it scrolls into view. Returns the unregister.
 *
 * One observer for every tile on the page rather than one per tile: the callback needs to
 * compare tiles against each other to pick a winner, which a per-element observer cannot
 * do, and a few thousand observers would be their own problem.
 */
export function observeForPreview(el: Element, path: string): () => void {
  if (prefersReducedMotion()) return () => {};

  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const observedPath = (entry.target as HTMLElement).dataset.mediaPath;
        if (observedPath) ratios.set(observedPath, entry.intersectionRatio);
      }
      chooseMostVisible();
    },
    { threshold: [0, 0.25, 0.5, 0.75, 1] },
  );

  observer.observe(el);

  return () => {
    observer?.unobserve(el);
    ratios.delete(path);
    releasePreview(path);
  };
}
