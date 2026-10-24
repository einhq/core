import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';

/**
 * Keeping the reader in place while a list grows above them.
 *
 * Any list that pages upward has the same problem: the pictures that arrive go
 * in above the viewport, and without a compensating scroll everything the
 * reader is looking at is shoved down the screen. The map's cluster popup and
 * the subject timelines share this, so they share the fix.
 *
 * What keeps a prepend invisible:
 *
 * - **Anchor on the picture at the top of the viewport**, not on the first in
 *   the list. A justified grid re-packs when it grows, and the first picture is
 *   exactly where that happens.
 * - **Turn the browser's own scroll anchoring off** (`overflow-anchor: none` on
 *   the scrolling element). It compensates too, and two corrections would move
 *   the reader by twice the prepended height.
 * - **Do not let a page merge into the bucket it joins** — see `bucketByDate`'s
 *   `startsSegment`. Row packing is greedy from the front, so an insertion
 *   re-packs everything after it, and no scroll correction can undo pixels
 *   changing *between* two visible tiles.
 * - **Hold a section where there is one, not a tile.** The grids virtualise
 *   their tiles, and a prepend of several screens moves the held tile out of
 *   its grid's window in the very commit that adds the rows — so it is gone
 *   before the first measurement, nothing corrects, and the sentinel at the
 *   top keeps firing. A dated section (`data-hold-anchor`) is always mounted.
 *   Lists without sections, like the map's cluster popup, still hold a tile.
 */

/** Stop once nothing has moved for this long… */
const HOLD_IDLE_MS = 400;
/** …and in any case after this long, so a list that never settles is not held for ever. */
const HOLD_MAX_MS = 4000;

/** The element a list scrolls in — or the window, when the page itself scrolls. */
export type ScrollRoot = HTMLElement | null;

type Held = { key: string; top: number; scrollTop: number };

/** Sections first, tiles as the fallback; document order puts a section before its tiles. */
const ANCHOR_SELECTOR = '[data-hold-anchor], [data-media-path]';
const anchorKey = (node: Element): string | null => node.getAttribute('data-hold-anchor') ?? node.getAttribute('data-media-path');
const findAnchor = (search: ParentNode, key: string): Element | null =>
  search.querySelector(`[data-hold-anchor="${CSS.escape(key)}"]`) ?? search.querySelector(`[data-media-path="${CSS.escape(key)}"]`);

const scrollTopOf = (root: ScrollRoot): number => root ? root.scrollTop : globalThis.scrollY;

const scrollBy = (root: ScrollRoot, delta: number): void => {
  if (root) root.scrollTop += delta;
  // `instant`, because theme.css sets `scroll-behavior: smooth` on the document
  // and an animated correction is precisely the movement this exists to prevent.
  else globalThis.scrollTo({ top: globalThis.scrollY + delta, behavior: 'instant' });
};

const container = (root: ScrollRoot): { search: ParentNode; edge: number } => root ? { search: root, edge: root.getBoundingClientRect().top } : { search: document, edge: 0 };

/** Where the held element sits right now, and from what scroll offset. */
const anchorPosition = (root: ScrollRoot, key: string): Held | null => {
  const node = findAnchor(container(root).search, key);
  return node ? { key, top: node.getBoundingClientRect().top, scrollTop: scrollTopOf(root) } : null;
};

/** The topmost section or picture the reader can actually see. */
const visibleAnchor = (root: ScrollRoot): Held | null => {
  const { search, edge } = container(root);
  for (const node of search.querySelectorAll(ANCHOR_SELECTOR)) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom <= edge) continue;
    const key = anchorKey(node);
    return key ? { key, top: rect.top, scrollTop: scrollTopOf(root) } : null;
  }
  return null;
};

/**
 * Keep `node` where it is on screen while the list around it settles — the
 * landing after a seek. The rows above it arrive in the same answer as the
 * seek, and their grids are skeletons on the first frame; without this the
 * sought date slides down the screen as they take their real height. Same
 * frame-to-frame correction as the prepend hold, same stopping rules.
 * Returns a cancel.
 */
export const holdElement = (node: Element, root: ScrollRoot): () => void => {
  let frame = 0;
  const started = performance.now();
  let lastChange = started;
  let lastTop = node.getBoundingClientRect().top;
  let lastScrollTop = scrollTopOf(root);
  let lastHeight = root ? root.scrollHeight : document.documentElement.scrollHeight;

  const hold = () => {
    if (node.isConnected) {
      const expected = lastTop - (scrollTopOf(root) - lastScrollTop);
      const drift = node.getBoundingClientRect().top - expected;
      if (Math.abs(drift) > 0.5) {
        scrollBy(root, drift);
        lastChange = performance.now();
      }
      lastTop = expected;
      lastScrollTop = scrollTopOf(root);
    }
    const height = root ? root.scrollHeight : document.documentElement.scrollHeight;
    if (height !== lastHeight) {
      lastHeight = height;
      lastChange = performance.now();
    }
    const at = performance.now();
    if (at - lastChange < HOLD_IDLE_MS && at - started < HOLD_MAX_MS) frame = requestAnimationFrame(hold);
  };

  frame = requestAnimationFrame(hold);
  return () => cancelAnimationFrame(frame);
};

export type PrependHold = {
  /**
   * Call immediately before the state update that prepends, while the DOM still
   * shows the old list. Returns nothing; it remembers what to hold on to.
   */
  capture: () => void;
};

/**
 * @param items What the list holds. The correction re-runs whenever this changes,
 *              which is how it lands on the render that added the new rows.
 * @param root  The scrolling element, or null when the page scrolls.
 */
export function usePrependHold(items: unknown, root: ScrollRoot): PrependHold {
  const held = useRef<Held | null>(null);

  const capture = useCallback(() => {
    held.current = visibleAnchor(root);
  }, [root]);

  // `useLayoutEffect` because the first correction has to happen before the
  // browser paints the new rows, or it reads as a jump. It then keeps correcting
  // until the list stops changing height: the grids settle in waves — mount,
  // measure, then again as pictures decode.
  useLayoutEffect(() => {
    const before = held.current;
    if (!before) return;
    held.current = null;

    let frame = 0;
    const started = performance.now();
    let lastChange = started;

    // Frame to frame, not against the original baseline: a correction is itself a
    // write to the scroll position, and measuring against a fixed baseline would
    // read that write back as more drift and apply it again every frame.
    let lastTop = before.top;
    let lastScrollTop = before.scrollTop;
    let lastHeight = root ? root.scrollHeight : document.documentElement.scrollHeight;

    const hold = () => {
      const now = anchorPosition(root, before.key);
      if (now) {
        // Where the picture would be if only the reader had moved.
        const expected = lastTop - (now.scrollTop - lastScrollTop);
        const drift = now.top - expected;
        if (Math.abs(drift) > 0.5) {
          scrollBy(root, drift);
          lastChange = performance.now();
        }
        lastTop = expected;
        lastScrollTop = scrollTopOf(root);
      }

      // The list growing is it still settling, whether or not it has moved the
      // held picture yet — so that keeps the hold alive too.
      const height = root ? root.scrollHeight : document.documentElement.scrollHeight;
      if (height !== lastHeight) {
        lastHeight = height;
        lastChange = performance.now();
      }

      const at = performance.now();
      if (at - lastChange < HOLD_IDLE_MS && at - started < HOLD_MAX_MS) frame = requestAnimationFrame(hold);
    };

    hold();
    return () => cancelAnimationFrame(frame);
  }, [items, root]);

  // Stable, because callers put it in the dependencies of the loader that calls
  // it: a fresh object each render would restart the list on every render.
  return useMemo(() => ({ capture }), [capture]);
}
