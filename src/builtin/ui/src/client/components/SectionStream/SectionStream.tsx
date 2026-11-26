import { Box } from '@mantine/core';
import { type ReactNode, type Ref, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVerticalWindow } from '../../hooks/useVerticalWindow.ts';
import { holdOffset, sectionAt, sectionHeight, sectionsInBand, sectionTop, streamHeight, type StreamLayout, streamLayout } from '../../lib/section-stream.ts';

/** What a page can ask of a stream. */
export type SectionStreamHandle = {
  /**
   * Bring the section `key` to `offset` px below the top of the window (by default the reading
   * line), once what the page has just changed is laid out.
   */
  scrollToKey: (key: string, opts?: { offset?: number }) => void;
  /**
   * The sections a band of the stream crosses, `top` to `bottom` in px from the stream's top, each
   * with where it starts and how tall it is there: from the stream's arithmetic, with no layout
   * read, so a lasso can ask every frame.
   */
  sectionsIn: (top: number, bottom: number) => { key: string; top: number; height: number; open: boolean }[];
};

export type SectionStreamProps<T> = {
  items: readonly T[];
  /** Stable per item: the section's key, and how it is found again after the list changes. */
  itemKey: (item: T) => string;
  /** The sections drawn open, by key. Each is measured and stays mounted; every other one is `closedHeight` tall. */
  openKeys: ReadonlySet<string>;
  closedHeight: number;
  /**
   * How tall a closed section is likely to be, when closed sections differ: each is then placed
   * at this height until it is mounted, and measured from then on rather than clipped. Without
   * it every closed section is exactly `closedHeight`.
   */
  estimate?: (item: T, index: number) => number;
  gap?: number;
  /** Draws one section. A closed one is given a box exactly `closedHeight` tall, and clipped to it, unless there is an `estimate`. */
  children: (item: T, index: number, open: boolean) => ReactNode;
  /**
   * Where the page's headers end, in px from the top of the window, or in a `scroller` its top:
   * the section across this line is the one held in place while sections above it change.
   */
  readingLine: number;
  /** The element the stream scrolls in, a pane of its own; the window when none. */
  scroller?: HTMLElement | null;
  /**
   * A closed section's outline as a CSS image, repeated down the stream under the sections, so a
   * fling — which mounts nothing until it slows — crosses section shapes rather than a blank page.
   */
  skeleton?: string;
  /** Told the key of the section across the reading line whenever another one is: a time rail's place. */
  onReadingLine?: (key: string | undefined) => void;
  ref?: Ref<SectionStreamHandle>;
};

type Snapshot = { layout: StreamLayout; keys: string[] };

/**
 * A long list of sections that are all one height until opened, of which only those near the
 * viewport are mounted.
 *
 * Because a closed section's height is fixed, where every section starts is arithmetic
 * (`lib/section-stream.ts`): the stream keeps its full height in the document from the first
 * frame, and only the open sections are measured. Those stay mounted wherever the window is.
 * With an `estimate`, closed sections differ in height: each stands at its estimate until it is
 * mounted, and at what it measured since, so the stream's height is close from the first frame
 * and exact where it has been seen.
 *
 * The reader is held in place: when a section above the one across the reading line opens,
 * closes, grows or leaves the list, the window (or the `scroller` the stream is in) is scrolled by
 * exactly the difference before the frame is painted, so what is being read does not move. The browser's own scroll anchoring is
 * off for the stream, which would otherwise compensate a second time.
 */
export function SectionStream<T>(
  { items, itemKey, openKeys, closedHeight, estimate, gap = 0, children, readingLine, scroller, skeleton, onReadingLine, ref }: SectionStreamProps<T>,
) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Heights measured, by `measureKey`: a section open and closed are two heights.
  const [measured, setMeasured] = useState<ReadonlyMap<string, number>>(() => new Map());

  const keys = useMemo(() => items.map(itemKey), [items, itemKey]);
  const openIndexes = useMemo(() => keys.flatMap((key, index) => openKeys.has(key) ? [index] : []), [keys, openKeys]);
  const layout = useMemo(() => {
    // Every section not `closedHeight` tall is given its own height; the layout's arithmetic
    // takes them all alike.
    const sized = new Map<number, number>();
    keys.forEach((key, index) => {
      const open = openKeys.has(key);
      if (open) sized.set(index, measured.get(measureKey(key, true)) ?? closedHeight);
      else if (estimate) sized.set(index, measured.get(measureKey(key, false)) ?? estimate(items[index], index));
    });
    return streamLayout(keys.length, closedHeight, gap, sized);
  }, [keys, items, openKeys, measured, closedHeight, estimate, gap]);
  const height = streamHeight(layout);

  const window = useVerticalWindow(rootRef, height);
  const range = window ? sectionsInBand(layout, window.top, window.bottom) : { start: 0, end: 0 };
  const mounted = useMemo(() => {
    const indexes = new Set<number>();
    for (let index = range.start; index < range.end; index++) indexes.add(index);
    for (const index of openIndexes) indexes.add(index);
    return [...indexes].sort((a, b) => a - b);
  }, [range.start, range.end, openIndexes]);

  const report = useCallback((key: string, value: number) => {
    setMeasured((previous) => {
      if (previous.get(key) === value) return previous;
      const next = new Map(previous);
      next.set(key, value);
      return next;
    });
  }, []);

  const pending = useRef<{ key: string; offset: number } | null>(null);
  const [scrollRequests, setScrollRequests] = useState(0);
  const previous = useRef<Snapshot | null>(null);
  const readingLineRef = useRef(readingLine);
  readingLineRef.current = readingLine;
  const scrollerRef = useRef(scroller);
  scrollerRef.current = scroller;

  const current = useRef({ layout, keys, openKeys });
  current.current = { layout, keys, openKeys };
  useImperativeHandle(ref, () => ({
    scrollToKey: (key, opts) => {
      pending.current = { key, offset: opts?.offset ?? readingLineRef.current };
      setScrollRequests((value) => value + 1);
    },
    sectionsIn: (top, bottom) => {
      const { layout, keys, openKeys } = current.current;
      const { start, end } = sectionsInBand(layout, top, bottom);
      const crossed = [];
      for (let index = start; index < end; index++) {
        crossed.push({ key: keys[index], top: sectionTop(layout, index), height: sectionHeight(layout, index), open: openKeys.has(keys[index]) });
      }
      return crossed;
    },
  }), []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const before = previous.current;
    previous.current = { layout, keys };
    if (!root) return;
    const rootTop = root.getBoundingClientRect().top;
    const scrolling = scrollerRef.current ?? globalThis;

    const request = pending.current;
    if (request) {
      pending.current = null;
      const index = keys.indexOf(request.key);
      if (index >= 0) {
        scrolling.scrollBy({ top: rootTop + sectionTop(layout, index) - request.offset, behavior: 'instant' });
        return;
      }
    }

    // The section across the reading line before this change, found again by its key.
    if (!before) return;
    const held = sectionAt(before.layout, readingLineRef.current - rootTop);
    if (held === undefined) return;
    const after = keys.indexOf(before.keys[held]);
    if (after < 0) return;
    const delta = holdOffset(before.layout, held, layout, after);
    if (delta !== 0) scrolling.scrollBy({ top: delta, behavior: 'instant' });
  }, [layout, keys, scrollRequests]);

  // The section across the reading line, said once per frame at most as the window scrolls, and
  // whenever the stream changes.
  const onReadingLineRef = useRef(onReadingLine);
  onReadingLineRef.current = onReadingLine;
  const said = useRef<string | undefined>(undefined);
  const sayReadingLine = useCallback(() => {
    const root = rootRef.current;
    if (!root || !onReadingLineRef.current) return;
    const at = sectionAt(current.current.layout, readingLineRef.current - root.getBoundingClientRect().top);
    const key = at === undefined ? undefined : current.current.keys[at];
    if (key === said.current) return;
    said.current = key;
    onReadingLineRef.current(key);
  }, []);
  useLayoutEffect(sayReadingLine, [layout, keys, sayReadingLine]);
  useLayoutEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        sayReadingLine();
      });
    };
    globalThis.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      cancelAnimationFrame(frame);
      globalThis.removeEventListener('scroll', onScroll, true);
    };
  }, [sayReadingLine]);

  // Runs of closed sections between the open ones, where the outline repeats evenly.
  const skeletonRuns = useMemo(() => {
    if (!skeleton) return [];
    const runs: { top: number; height: number }[] = [];
    let start = 0;
    for (const open of [...openIndexes, layout.count]) {
      if (open > start) {
        const top = sectionTop(layout, start);
        runs.push({ top, height: sectionTop(layout, open - 1) + sectionHeight(layout, open - 1) - top });
      }
      start = open + 1;
    }
    return runs;
  }, [layout, openIndexes, skeleton]);

  return (
    <Box ref={rootRef} pos='relative' style={{ height, overflowAnchor: 'none' }}>
      {skeletonRuns.map((run) => (
        <Box
          key={run.top}
          aria-hidden
          pos='absolute'
          style={{
            top: run.top,
            left: 0,
            right: 0,
            height: run.height,
            backgroundImage: skeleton,
            backgroundSize: `100% ${closedHeight + gap}px`,
            backgroundRepeat: 'repeat-y',
            pointerEvents: 'none',
          }}
        />
      ))}
      {mounted.map((index) => {
        const item = items[index];
        const key = keys[index];
        const open = openKeys.has(key);
        const sized = open || estimate !== undefined;
        return (
          <Box
            key={key}
            data-section-key={key}
            pos='absolute'
            style={{
              top: sectionTop(layout, index),
              left: 0,
              right: 0,
              ...(sized ? {} : { height: closedHeight, overflow: 'hidden' }),
              // Painted over the outline layer, which a mounted section covers.
              background: 'var(--mrx-surface-base)',
            }}
          >
            {sized ? <Measured sectionKey={measureKey(key, open)} onHeight={report}>{children(item, index, open)}</Measured> : children(item, index, false)}
          </Box>
        );
      })}
    </Box>
  );
}

/** What a section's height is kept under: open and closed apart. */
const measureKey = (key: string, open: boolean) => `${open ? 'open' : 'closed'}\n${key}`;

/** An open section, or a closed one of its own height, reporting its height whenever it changes. */
function Measured({ sectionKey, onHeight, children }: { sectionKey: string; onHeight: (key: string, height: number) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => onHeight(sectionKey, Math.ceil(node.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [sectionKey, onHeight]);
  return <div ref={ref}>{children}</div>;
}
