import { type RefObject, useCallback, useLayoutEffect, useState } from 'react';
import { createScrollVelocityGate } from '../lib/scroll-velocity.ts';

/**
 * Which slice of a tall, exactly-measured grid needs DOM nodes.
 *
 * Shared by the two grids because it is the only part of windowing that does not
 * depend on what is being laid out: the media grid packs rows of varying height
 * from aspect ratios, the card grid computes uniform rows arithmetically, and
 * both then need the same answer to "which vertical band is near the viewport".
 * The caller owns the geometry and the mapping from this band to items.
 */

/** Render a full viewport before and after the visible rows to keep scrolling seamless. */
const WINDOW_OVERSCAN_MIN = 800;

/** Do not mount rows that the user only passes while a fast scroll is still moving. */
export const WINDOW_SCROLL_IDLE_MS = 150;
/** Slow browsing updates in small batches rather than re-rendering every scroll event. */
export const WINDOW_SCROLL_LIVE_MS = 60;

export type VerticalWindow = { top: number; bottom: number };

/**
 * The viewport expressed in the grid's local coordinates.
 *
 * The grid keeps its full, exact height in the document; this only decides which rows
 * need DOM nodes. Capturing scroll lets this also work inside a scrolling panel.
 */
export function useVerticalWindow(root: RefObject<HTMLElement | null>, height: number): VerticalWindow | undefined {
  const [window, setWindow] = useState<VerticalWindow>();

  const measure = useCallback(() => {
    const node = root.current;
    if (!node) return;

    const viewportHeight = globalThis.innerHeight;
    if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return;

    const rect = node.getBoundingClientRect();
    const overscan = Math.max(viewportHeight, WINDOW_OVERSCAN_MIN);
    const next = {
      top: Math.max(0, -rect.top - overscan),
      bottom: Math.min(height, viewportHeight - rect.top + overscan),
    };

    setWindow((previous) => (
      previous?.top === next.top && previous.bottom === next.bottom ? previous : next
    ));
  }, [height, root]);

  // The first pass intentionally has no tiles. A layout effect fills the local viewport
  // before paint, avoiding an initial mount of every tile in a very large album.
  useLayoutEffect(() => {
    let scrollIdleTimer: number | undefined;
    let liveTimer: number | undefined;
    let lastLiveMeasure = 0;
    const velocity = createScrollVelocityGate();

    const onScroll = () => {
      const node = root.current;
      if (!node) return;
      const now = performance.now();
      const fast = velocity.sample(node.getBoundingClientRect().top, now);

      if (fast) {
        if (liveTimer !== undefined) {
          globalThis.clearTimeout(liveTimer);
          liveTimer = undefined;
        }
        if (scrollIdleTimer !== undefined) globalThis.clearTimeout(scrollIdleTimer);
        scrollIdleTimer = globalThis.setTimeout(() => {
          scrollIdleTimer = undefined;
          velocity.reset();
          lastLiveMeasure = performance.now();
          measure();
        }, WINDOW_SCROLL_IDLE_MS);
        return;
      }

      // Once a fling slows below the threshold, resume filling the viewport
      // without making the reader stop. Keep this lightly throttled because a
      // timeline can have many independent month grids listening to one scroll.
      if (scrollIdleTimer !== undefined) {
        globalThis.clearTimeout(scrollIdleTimer);
        scrollIdleTimer = undefined;
      }
      if (liveTimer !== undefined) return;
      const delay = Math.max(0, WINDOW_SCROLL_LIVE_MS - (now - lastLiveMeasure));
      liveTimer = globalThis.setTimeout(() => {
        liveTimer = undefined;
        lastLiveMeasure = performance.now();
        measure();
      }, delay);
    };

    measure();
    globalThis.addEventListener('scroll', onScroll, { capture: true, passive: true });
    globalThis.addEventListener('resize', measure, { passive: true });
    return () => {
      if (scrollIdleTimer !== undefined) globalThis.clearTimeout(scrollIdleTimer);
      if (liveTimer !== undefined) globalThis.clearTimeout(liveTimer);
      globalThis.removeEventListener('scroll', onScroll, true);
      globalThis.removeEventListener('resize', measure);
    };
  }, [measure]);

  return window;
}
