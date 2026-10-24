import { Box } from '@mantine/core';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSignals } from '@preact/signals-react/runtime';
import type { MediaItem } from '../../signals/album.ts';
import { clearLightboxReturn, lightboxReturnPath, openMediaAt } from '../../signals/album.ts';
import { pageLocation } from '../../signals/module-ui.ts';
import { fullscreenRouteFromSearch } from '../../lib/fullscreen-search.ts';
import {
  DEFAULT_ASPECT,
  defaultItemsPerRow,
  defaultRowHeight,
  displayAspect,
  justifiedLayout,
  squareColumns,
  squareLayout,
  tileRangeForVerticalWindow,
} from '../../lib/justified-layout.ts';
import { WAVEFORM_ASPECT } from '../../lib/derivatives.ts';
import { getAspect, rememberAspect } from '../../lib/aspect-cache.ts';
import { versionOf } from '../../lib/derivative-version.ts';
import { loadStars, starredPaths } from '../../signals/stars.ts';
import { phoneGridColumns, setPhoneGridColumns } from '../../signals/ui.ts';
import { pinchStep, stepColumns } from '../../lib/pinch.ts';
import { useElementWidth } from '../../hooks/useElementWidth.ts';
import { useHeaderHeight } from '../../hooks/useHeaderHeight.ts';
import { useVerticalWindow, WINDOW_SCROLL_IDLE_MS, WINDOW_SCROLL_LIVE_MS } from '../../hooks/useVerticalWindow.ts';
import type { MediaSelection } from '../../hooks/useMediaSelection.ts';
import type { TileBox } from '../../lib/grid-nav.ts';
import type { MediaDragPayload } from '../../lib/media-drag.ts';
import { MediaTile } from './MediaTile.tsx';
import { MediaGridSkeleton } from './MediaGridSkeleton.tsx';

/** Room left between a tile the closing lightbox scrolls back into view and the screen's edge. */
const RETURN_EDGE_GAP = 16;

/**
 * Gutter between tiles. Matches `theme.other.gridGutter`, in px because the layout is
 * arithmetic. Tight on purpose: the pictures are the content, and the gutter is only
 * there to keep two adjacent images from reading as one.
 */
export const GRID_GAP = 3;

export type MediaGridProps = {
  items: MediaItem[];
  /** Row height to aim for. Defaults to a responsive height from the measured width. */
  targetRowHeight?: number;
  gap?: number;
  /** Added to a tile's local index before `onOpen` — a timeline group's offset into the flat list. */
  indexOffset?: number;
  /** The list the lightbox navigates. Defaults to `items`. */
  lightboxItems?: MediaItem[];
  /** Defaults to opening the app lightbox. */
  onOpen?: (index: number, items: MediaItem[]) => void;
  /** Multi-select, owned by the caller so several grids can share one selection. */
  selection?: MediaSelection;
  /**
   * A badge for a tile, e.g. a relevance score: the tile lays it out in its lower-left marks row,
   * after the heart and the lock, so it is not positioned itself. `mrx-tile-badge` styles it.
   */
  renderOverlay?: (item: MediaItem) => ReactNode;
  /**
   * Lock the tiles of media that keeps its own sharing (`MediaItem.pinned`): for a reader who may
   * change the sharing of the album it is in, whose changes do not reach those.
   */
  markPinned?: boolean;
  /** Placeholder tiles while `items` is still loading. */
  loading?: boolean;
  /**
   * On a phone, let the pictures run to the screen edges past the shell's padding.
   *
   * Opt-in rather than automatic: a grid inside a panel — the map's cluster popup —
   * would break out of it. See `.mrx-grid-bleed` in `theme/theme.css`.
   */
  bleed?: boolean;
  /**
   * Square tiles in fixed columns (`squareLayout`) instead of a justified grid, this
   * many across on a phone and more on a wider screen (`squareColumns`): an overview,
   * where the pictures' shapes are not the point.
   */
  square?: number;
  /**
   * The tile a page's keyboard cursor is on: drawn with a ring, kept mounted and scrolled into
   * view (nearest edge, under the headers) when it changes.
   */
  focusPath?: string;
  /**
   * Whether tiles take focus and open on Enter or Space. Off for a page whose keys act on what
   * the grid shows — Enter there means the page's own action. Defaults to on.
   */
  tileKeys?: boolean;
  /**
   * Whether a tile may fall back to the original. Off, a file with no renditions yet draws a
   * placeholder and asks for nothing, which needs `hasDerivatives` on the items (a layout asked
   * with `--fields derivatives`). Defaults to on.
   */
  originals?: boolean;
  /** Told the tiles' boxes, in item order, and the grid's height whenever the layout changes: for keys and hit tests. */
  onLayout?: (tiles: readonly TileBox[], height: number) => void;
  /**
   * What dragging a tile carries (`startMediaDrag`), or nothing when it is not dragged: as a rule
   * the selection, from a selected tile. Asked for each tile drawn, so it should answer from what
   * it already holds.
   */
  dragPayload?: (item: MediaItem) => MediaDragPayload | undefined;
};

/**
 * A justified grid of media: rows of pictures at their own aspect ratios, filled to the
 * container width. A sparse final row stays ragged; one over 80% full is justified.
 *
 * Tiles are absolutely positioned rather than laid out as flex rows. That keeps the
 * rounding exact (a flex row's `flex-grow` rounds per item and leaves a sliver at the
 * right edge), keeps DOM order equal to visual order — which shift-range selection and
 * tab order both depend on — and leaves the row geometry available for windowing.
 */
export function MediaGrid({
  items,
  targetRowHeight,
  gap = GRID_GAP,
  indexOffset = 0,
  lightboxItems,
  onOpen,
  selection,
  renderOverlay,
  markPinned = false,
  loading = false,
  bleed = false,
  square,
  focusPath,
  tileKeys = true,
  originals = true,
  onLayout,
  dragPayload,
}: MediaGridProps) {
  // For `versionOf` and the stars below: the grid subscribes to the derivative-version and the
  // favourites signals once, on behalf of every tile in it, so a rotation or a heart re-renders
  // one component rather than a few thousand of them each holding their own subscription.
  useSignals();
  const starred = starredPaths.value;
  const phoneColumns = phoneGridColumns.value;
  useEffect(() => void loadStars(), []);

  const [widthRef, width] = useElementWidth<HTMLDivElement>();
  const gridRef = useRef<HTMLDivElement | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    gridRef.current = node;
    widthRef(node);
  }, [widthRef]);

  // Aspects measured from images that have decoded, for files without stored width and
  // height.
  const [measured, setMeasured] = useState<Record<string, number>>(() => {
    const seeded: Record<string, number> = {};
    for (const item of items) {
      const cached = getAspect(item.path);
      if (cached !== undefined) seeded[item.path] = cached;
    }
    return seeded;
  });

  const pendingRef = useRef<Record<string, number>>({});
  const frameRef = useRef(0);

  // The aspect each item is currently laid out with, so a correction can be compared
  // against what is actually on screen rather than against nothing.
  const assumedRef = useRef(new Map<string, number>());

  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  const onMeasure = useCallback((path: string, aspect: number) => {
    rememberAspect(path, aspect);
    pendingRef.current[path] = aspect;

    // One relayout per frame however many tiles decode together — otherwise a screenful
    // of images arriving at once is a screenful of layout passes.
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const batch = pendingRef.current;
      pendingRef.current = {};

      setMeasured((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [key, value] of Object.entries(batch)) {
          // Compare against the aspect the tile is drawn with, not against the last
          // measurement. A file whose stored dimensions were already right decodes to
          // the same shape it is being shown at, and re-laying the page out over a
          // rounding difference moves every tile in the row by a pixel for nothing.
          const shown = assumedRef.current.get(key);
          if (shown !== undefined && Math.abs(shown - value) / value < 0.01) continue;
          next[key] = value;
          changed = true;
        }
        return changed ? next : prev;
      });
    });
  }, []);

  const aspects = useMemo(() => {
    const shown = new Map<string, number>();
    const list = items.map((item) => {
      // Audio has no stored dimensions and never will — its picture is a synthesised
      // waveform at a fixed aspect, so that is a better guess than the photo default and
      // spares the grid a relayout when the image decodes.
      const fallback = item.type === 'audio' ? WAVEFORM_ASPECT : DEFAULT_ASPECT;
      const aspect = measured[item.path] ?? displayAspect(item) ?? fallback;
      shown.set(item.path, aspect);
      return aspect;
    });
    assumedRef.current = shown;
    return list;
  }, [items, measured]);

  const target = targetRowHeight ?? defaultRowHeight(width);
  // A caller asking for a row height (the chat) gets the justified fill everywhere.
  const columns = square !== undefined ? squareColumns(width, square) : undefined;
  // A phone's count is the reader's, set by pinching (below); wider screens fill rows by height.
  const phone = targetRowHeight === undefined && defaultItemsPerRow(width) !== undefined;
  const itemsPerRow = columns ?? (phone ? phoneColumns : undefined);

  const layout = useMemo(
    () =>
      columns !== undefined
        ? squareLayout(aspects.length, { containerWidth: width, columns, gap })
        : justifiedLayout(aspects, { containerWidth: width, targetRowHeight: target, gap, itemsPerRow }),
    [aspects, width, target, gap, itemsPerRow, columns],
  );

  const onLayoutRef = useRef(onLayout);
  onLayoutRef.current = onLayout;
  useEffect(() => {
    if (width === 0) return;
    onLayoutRef.current?.(layout.tiles.map((tile) => ({ left: tile.left, top: tile.top, width: tile.width, height: tile.height })), layout.height);
  }, [layout, width]);

  const verticalWindow = useVerticalWindow(gridRef, layout.height);
  const tileRange = useMemo(
    () => verticalWindow && tileRangeForVerticalWindow(layout.rows, verticalWindow.top, verticalWindow.bottom),
    [layout.rows, verticalWindow],
  );
  const visibleTiles = tileRange ? layout.tiles.slice(tileRange.firstIndex, tileRange.afterLastIndex) : [];
  const returnPath = lightboxReturnPath.value;
  const returnIndex = returnPath ? items.findIndex((item) => item.path === returnPath) : -1;
  const returnTile = returnIndex >= 0 ? layout.tiles[returnIndex] : undefined;
  const focusIndex = focusPath ? items.findIndex((item) => item.path === focusPath) : -1;
  const focusTile = focusIndex >= 0 ? layout.tiles[focusIndex] : undefined;
  // The tile the lightbox returns to and the keyboard's tile are mounted wherever the window is.
  const forced = [returnTile, focusTile].filter((tile): tile is NonNullable<typeof tile> => tile !== undefined && !visibleTiles.some((shown) => shown.index === tile.index));
  const renderedTiles = forced.length > 0 ? [...visibleTiles, ...new Map(forced.map((tile) => [tile.index, tile])).values()].sort((a, b) => a.index - b.index) : visibleTiles;

  // The requested tile is forced into the window above, so scrollIntoView works even when
  // the lightbox arrowed several screens away from the tile that originally opened it.
  // Keep it forced briefly after the jump, until the normal scroll measurement catches up.
  // A tile already wholly on screen is left where it is: the grid does not move under
  // the reader for a picture they can already see.
  const headerHeight = useHeaderHeight();
  useLayoutEffect(() => {
    if (!returnPath || !returnTile || !gridRef.current) return;
    const root = gridRef.current;
    let clearTimer: number | undefined;
    let frame = 0;
    let revealed: HTMLElement | undefined;
    // Wait one frame for Mantine's scroll lock to leave the document with the modal, and then for
    // the page's URL to drop the full-screen route: a close steps back in history after the
    // lightbox is gone, and the browser restores the scroll position it saved when the lightbox
    // opened, undoing a reveal made before it.
    const reveal = () => {
      if (fullscreenRouteFromSearch(pageLocation()?.search ?? '') !== undefined) {
        frame = requestAnimationFrame(reveal);
        return;
      }
      const tile = [...root.querySelectorAll<HTMLElement>('[data-media-path]')]
        .find((node) => node.dataset.mediaPath === returnPath);
      if (!tile) return;

      const rect = tile.getBoundingClientRect();
      const inView = rect.top >= headerHeight && rect.bottom <= globalThis.innerHeight;
      // The nearest edge, not the centre: a tile below the screen comes up to sit just above its
      // bottom, one above comes down to just under the header, as if the grid had been scrolled
      // there by hand in the direction the lightbox went.
      if (!inView) {
        tile.style.scrollMarginTop = `${headerHeight + RETURN_EDGE_GAP}px`;
        tile.style.scrollMarginBottom = `${RETURN_EDGE_GAP}px`;
        tile.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        tile.style.scrollMarginTop = '';
        tile.style.scrollMarginBottom = '';
      }
      tile.focus({ preventScroll: true });
      // The lightbox's closing picture waits for this before it flies back into the tile.
      tile.dataset.lightboxReturned = '';
      revealed = tile;
      clearTimer = globalThis.setTimeout(() => clearLightboxReturn(returnPath), WINDOW_SCROLL_IDLE_MS + WINDOW_SCROLL_LIVE_MS);
    };
    frame = requestAnimationFrame(reveal);
    return () => {
      cancelAnimationFrame(frame);
      if (clearTimer !== undefined) globalThis.clearTimeout(clearTimer);
      if (revealed) delete revealed.dataset.lightboxReturned;
    };
  }, [returnPath, returnTile, headerHeight]);

  // The keyboard's tile comes into view when it moves, by the nearest edge, under the headers.
  useLayoutEffect(() => {
    if (!focusPath || !focusTile || !gridRef.current) return;
    const tile = [...gridRef.current.querySelectorAll<HTMLElement>('[data-media-path]')].find((node) => node.dataset.mediaPath === focusPath);
    if (!tile) return;
    const rect = tile.getBoundingClientRect();
    if (rect.top >= headerHeight && rect.bottom <= globalThis.innerHeight) return;
    tile.style.scrollMarginTop = `${headerHeight + RETURN_EDGE_GAP}px`;
    tile.style.scrollMarginBottom = `${RETURN_EDGE_GAP}px`;
    tile.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    tile.style.scrollMarginTop = '';
    tile.style.scrollMarginBottom = '';
  }, [focusPath, focusTile === undefined]);

  // Two fingers on a phone's grid change how many pictures a row holds: spread for fewer and bigger,
  // close for more. The grid takes the gesture from the browser (`mrx-grid-pinch`), whose own pinch
  // zoom would otherwise have it; one finger still scrolls.
  const pinchable = phone && columns === undefined;
  const drawn = width !== 0 && !loading;
  useEffect(() => {
    const el = gridRef.current;
    if (!el || !pinchable) return;
    let start = 0;
    let last = 0;
    const spread = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const onStart = (event: TouchEvent) => {
      if (event.touches.length === 2) start = last = spread(event.touches);
    };
    const onMove = (event: TouchEvent) => {
      if (event.touches.length === 2 && start > 0) last = spread(event.touches);
    };
    const onEnd = (event: TouchEvent) => {
      if (start === 0 || event.touches.length >= 2) return;
      const step = pinchStep(start, last);
      start = 0;
      if (step !== 0) setPhoneGridColumns(stepColumns(phoneGridColumns.peek(), step));
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: true });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [pinchable, drawn]);

  const open = useCallback((index: number) => {
    const list = lightboxItems ?? items;
    (onOpen ?? openMediaAt)(indexOffset + index, list);
  }, [onOpen, lightboxItems, items, indexOffset]);

  // Nothing is measured on the very first frame; drawing at width 0 would flash an empty
  // block before the real grid.
  if (width === 0 || loading) {
    return (
      <Box ref={ref} className={bleed ? 'mrx-grid-bleed' : undefined}>
        <MediaGridSkeleton containerWidth={width} targetRowHeight={target} gap={gap} itemsPerRow={itemsPerRow} />
      </Box>
    );
  }

  return (
    <Box
      ref={ref}
      className={[bleed ? 'mrx-grid-bleed' : '', pinchable ? 'mrx-grid-pinch' : ''].filter(Boolean).join(' ') || undefined}
      style={{ position: 'relative', height: layout.height }}
    >
      {renderedTiles.map((tile) => {
        const item = items[tile.index];
        return (
          <MediaTile
            key={item.path}
            media={item}
            left={tile.left}
            top={tile.top}
            width={tile.width}
            height={tile.height}
            aspect={aspects[tile.index]}
            selectable={selection !== undefined}
            selected={selection?.isSelected(item.path) ?? false}
            selecting={selection?.active ?? false}
            version={versionOf(item.path)}
            starred={starred.has(item.path)}
            pinned={markPinned && item.pinned === true}
            onOpen={() => (selection?.active ? selection.toggle(item.path) : open(tile.index))}
            onToggle={(mods) => selection?.toggle(item.path, mods)}
            onMeasure={onMeasure}
            overlay={renderOverlay?.(item)}
            focused={item.path === focusPath}
            keys={tileKeys}
            originals={originals}
            dragPayload={dragPayload?.(item)}
          />
        );
      })}
    </Box>
  );
}
