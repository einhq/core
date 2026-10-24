import { Box } from '@mantine/core';
import { type ReactNode, type Ref, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CARD_GAP, CARD_TEXT_HEIGHT, cardLayout, cardPosition, cardRangeForVerticalWindow, cardTextHeight, type CardTextParts, textPartsOf } from '../../lib/card-layout.ts';
import { useElementWidth } from '../../hooks/useElementWidth.ts';
import { useVerticalWindow } from '../../hooks/useVerticalWindow.ts';
import { CardFitProvider } from './cardFit.ts';
import { EntityCardSkeleton } from '../EntityCard/EntityCard.tsx';

export type CardGridProps<T> = {
  items: readonly T[];
  /** Stable identity per item — the key, and what a re-render keys off. */
  itemKey: (item: T, index: number) => string;
  /** Draws one card. It is given the exact box to fill, so it need not measure. */
  children: (item: T, index: number) => ReactNode;
  gap?: number;
  /**
   * What an item's card draws below its title. The grid reserves the height of
   * the fullest card among its items, so a grid of names alone is not padded to
   * the height of a card with a date, a description and badges. Omitted, it
   * reserves all of them — for cards whose content arrives after they mount.
   */
  textParts?: (item: T) => CardTextParts;
  /**
   * Called with the grid's row geometry whenever it changes, for a caller that
   * needs to map a position back to a scroll offset — the time rail does.
   */
  onGeometry?: (geometry: { columns: number; cardHeight: number; gap: number; height: number }) => void;
  /**
   * Skeleton cards laid out after the items — a page that is still to come, so a
   * fast scroll lands on the grid's structure instead of its end.
   */
  placeholders?: number;
  /**
   * Attached to a box spanning the placeholder rows, mounted whatever the window
   * shows — where an infinite-scroll sentinel goes, so a scroll that jumps past the
   * first placeholder row still reaches it.
   */
  placeholderRef?: Ref<HTMLDivElement>;
};

/**
 * A windowed grid of uniform cards.
 *
 * The grid keeps its full height in the document and mounts only the rows near
 * the viewport, so a page of five thousand albums costs the DOM of a screenful.
 * That is the same bargain `MediaGrid` makes — and the same
 * {@link useVerticalWindow} drives both — but the geometry here is arithmetic
 * rather than a packing pass, because every card is the same size.
 *
 * Cards are absolutely positioned rather than laid out by CSS grid: the row
 * offsets have to exist as numbers anyway for the windowing, and computing them
 * twice is how the two drift apart.
 */
export function CardGrid<T>({ items, itemKey, children, gap = CARD_GAP, textParts, onGeometry, placeholders = 0, placeholderRef }: CardGridProps<T>) {
  const [widthRef, width] = useElementWidth<HTMLDivElement>();
  const gridRef = useRef<HTMLDivElement | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    gridRef.current = node;
    widthRef(node);
  }, [widthRef]);

  const textHeight = useMemo(() => (textParts ? cardTextHeight(textPartsOf(items, textParts)) : CARD_TEXT_HEIGHT), [items, textParts]);

  // The tallest a mounted card has said it needs (`useCardFit`). Kept against the
  // width and the reserve it was measured at: a different width wraps differently,
  // and a different reserve is a different starting point.
  const fitKey = `${width}:${textHeight}`;
  const [fitted, setFitted] = useState({ key: '', height: 0 });
  const minCardHeight = fitted.key === fitKey ? fitted.height : 0;
  const reportFit = useCallback((naturalHeight: number) => {
    const height = Math.ceil(naturalHeight);
    setFitted((previous) => (previous.key === fitKey && previous.height >= height ? previous : { key: fitKey, height }));
  }, [fitKey]);

  const count = items.length + placeholders;
  const layout = useMemo(() => cardLayout(count, width, gap, textHeight, minCardHeight), [count, width, gap, textHeight, minCardHeight]);
  useKeepRowsInPlace(gridRef, layout.cardHeight, width, gap);
  const window = useVerticalWindow(gridRef, layout.height);
  const range = useMemo(
    () => cardRangeForVerticalWindow(count, layout, window, gap),
    [count, layout, window, gap],
  );

  const slotMask = useMemo(() => slotMaskFor({ ...layout, width }, gap), [layout, width, gap]);

  const geometryRef = useRef('');
  const signature = `${layout.columns}:${layout.cardHeight}:${gap}:${layout.height}`;
  if (onGeometry && geometryRef.current !== signature && width > 0) {
    geometryRef.current = signature;
    onGeometry({ columns: layout.columns, cardHeight: layout.cardHeight, gap, height: layout.height });
  }

  return (
    <CardFitProvider value={reportFit}>
      <Box ref={ref} pos='relative' style={{ height: layout.height }}>
        {
          /* Every slot, drawn by the compositor rather than by React. Rows are only
            mounted once a fast scroll slows, and a phone fling is fast all the way,
            so without this it crosses an empty grid. Cards mount on top of it. */
        }
        {slotMask && slotLayers(count, { ...layout, width }, gap).map((layer) => (
          <Box
            key={layer.top}
            aria-hidden
            pos='absolute'
            style={{
              top: layer.top,
              left: 0,
              width: layer.width,
              height: layer.height,
              background: 'var(--mrx-surface-raised)',
              maskImage: slotMask,
              WebkitMaskImage: slotMask,
              maskSize: `${width}px ${layout.cardHeight + gap}px`,
              WebkitMaskSize: `${width}px ${layout.cardHeight + gap}px`,
              maskRepeat: 'repeat-y',
              WebkitMaskRepeat: 'repeat-y',
              pointerEvents: 'none',
            }}
          />
        ))}
        {Array.from({ length: range.end - range.start }, (_, offset) => {
          const index = range.start + offset;
          const item = index < items.length ? items[index] : undefined;
          const { top, left } = cardPosition(index, layout, gap);
          return (
            <Box
              key={item === undefined ? `placeholder:${index}` : itemKey(item, index)}
              pos='absolute'
              style={{
                top,
                left,
                width: layout.cardWidth,
                height: layout.cardHeight,
                // The card fills this box exactly; anything its text would add past
                // the reserved block is clipped rather than pushing the row over.
                overflow: 'hidden',
              }}
            >
              {item === undefined ? <EntityCardSkeleton /> : children(item, index)}
            </Box>
          );
        })}
        {placeholders > 0 && (
          <Box
            ref={placeholderRef}
            aria-hidden
            pos='absolute'
            style={{ top: cardPosition(items.length, layout, gap).top, left: 0, right: 0, bottom: 0, pointerEvents: 'none' }}
          />
        )}
      </Box>
    </CardFitProvider>
  );
}

/** Card corner radius, Mantine's `md`, which `EntityCard` uses. */
const SLOT_RADIUS = 8;

/**
 * One row of card-shaped slots as a CSS mask, repeated down the grid. Laid out
 * at the grid's own width so the columns are exact; only rows repeat, and those
 * are whole pixels (`cardLayout`).
 */
function slotMaskFor(layout: SlotGeometry, gap: number): string | undefined {
  if (layout.cardWidth <= 0 || layout.cardHeight <= 0) return undefined;
  const { width } = layout;
  const rects = Array.from(
    { length: layout.columns },
    (_, column) => `<rect x='${column * (layout.cardWidth + gap)}' width='${layout.cardWidth}' height='${layout.cardHeight}' rx='${SLOT_RADIUS}'/>`,
  ).join('');
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${layout.cardHeight + gap}' preserveAspectRatio='none'>${rects}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

type SlotGeometry = { columns: number; cardWidth: number; cardHeight: number; width: number };

/**
 * Where the slot mask is drawn: the full rows, then the last row cut to the
 * cards it holds, so no slot is painted past the final card.
 */
function slotLayers(count: number, layout: SlotGeometry, gap: number): { top: number; width: number; height: number }[] {
  const stride = layout.cardHeight + gap;
  const fullRows = Math.floor(count / layout.columns);
  const rest = count % layout.columns;
  const layers = [];
  if (fullRows > 0) layers.push({ top: 0, width: layout.width, height: fullRows * stride - gap });
  if (rest > 0) layers.push({ top: fullRows * stride, width: rest * (layout.cardWidth + gap) - gap, height: layout.cardHeight });
  return layers;
}

/**
 * Holds the rows on screen still when every card grows.
 *
 * A card that reports it needs more height grows all of them, and every row
 * above the viewport pushes the rows under it down by the difference — a jump
 * of a screen or more, far down a long grid. Scrolling by the same amount keeps
 * what the reader is looking at where it was. A width change is a new layout
 * altogether, and not compensated.
 */
function useKeepRowsInPlace(gridRef: { current: HTMLElement | null }, cardHeight: number, width: number, gap: number) {
  const previous = useRef({ cardHeight, width });

  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { cardHeight, width };
    const grid = gridRef.current;
    if (!grid || before.width !== width || cardHeight <= before.cardHeight) return;

    const above = -grid.getBoundingClientRect().top;
    if (above <= 0) return;
    const rowsAbove = Math.floor(above / (before.cardHeight + gap));
    if (rowsAbove > 0) scrollParentOf(grid).scrollBy(0, rowsAbove * (cardHeight - before.cardHeight));
  }, [gridRef, cardHeight, width, gap]);
}

/** The nearest ancestor that scrolls vertically, or the window. */
function scrollParentOf(node: HTMLElement): { scrollBy: (x: number, y: number) => void } {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if ((overflowY === 'auto' || overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return globalThis;
}
