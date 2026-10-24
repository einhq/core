import { Box } from '@mantine/core';
import { type ReactNode, type Ref, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVerticalWindow } from '../../hooks/useVerticalWindow.ts';
import { holdOffset, sectionAt, sectionHeight, sectionsInBand, sectionTop, streamHeight, type StreamLayout, streamLayout } from '../../lib/section-stream.ts';

/** What a page can ask of a stream. */
export type SectionStreamHandle = {
  /**
   * Bring the section `key` to `offset` px below the top of the window (the page's headers),
   * once what the page has just changed is laid out.
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
  /** The sections drawn open, by key. Each is measured; every other one is `closedHeight` tall. */
  openKeys: ReadonlySet<string>;
  closedHeight: number;
  gap?: number;
  /** Draws one section. A closed one is given a box exactly `closedHeight` tall, and clipped to it. */
  children: (item: T, index: number, open: boolean) => ReactNode;
  /**
   * Where the page's headers end, in px from the top of the window: the section across this line
   * is the one held in place while sections above it change.
   */
  readingLine: number;
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
 *
 * The reader is held in place: when a section above the one across the reading line opens,
 * closes, grows or leaves the list, the window is scrolled by exactly the difference before the
 * frame is painted, so what is being read does not move. The browser's own scroll anchoring is
 * off for the stream, which would otherwise compensate a second time.
 */
export function SectionStream<T>({ items, itemKey, openKeys, closedHeight, gap = 0, children, readingLine, skeleton, onReadingLine, ref }: SectionStreamProps<T>) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState<ReadonlyMap<string, number>>(() => new Map());

  const keys = useMemo(() => items.map(itemKey), [items, itemKey]);
  const layout = useMemo(() => {
    const open = new Map<number, number>();
    keys.forEach((key, index) => {
      if (openKeys.has(key)) open.set(index, measured.get(key) ?? closedHeight);
    });
    return streamLayout(keys.length, closedHeight, gap, open);
  }, [keys, openKeys, measured, closedHeight, gap]);
  const height = streamHeight(layout);

  const window = useVerticalWindow(rootRef, height);
  const range = window ? sectionsInBand(layout, window.top, window.bottom) : { start: 0, end: 0 };
  const mounted = useMemo(() => {
    const indexes = new Set<number>();
    for (let index = range.start; index < range.end; index++) indexes.add(index);
    for (const index of layout.openIndexes) indexes.add(index);
    return [...indexes].sort((a, b) => a - b);
  }, [range.start, range.end, layout]);

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

    const request = pending.current;
    if (request) {
      pending.current = null;
      const index = keys.indexOf(request.key);
      if (index >= 0) {
        globalThis.scrollTo({ top: rootTop + globalThis.scrollY + sectionTop(layout, index) - request.offset, behavior: 'instant' });
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
    if (delta !== 0) globalThis.scrollBy({ top: delta, behavior: 'instant' });
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
    for (const open of [...layout.openIndexes, layout.count]) {
      if (open > start) {
        const top = sectionTop(layout, start);
        runs.push({ top, height: sectionTop(layout, open - 1) + closedHeight - top });
      }
      start = open + 1;
    }
    return runs;
  }, [layout, skeleton, closedHeight]);

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
        return (
          <Box
            key={key}
            data-section-key={key}
            pos='absolute'
            style={{
              top: sectionTop(layout, index),
              left: 0,
              right: 0,
              ...(open ? {} : { height: closedHeight, overflow: 'hidden' }),
              // Painted over the outline layer, which a mounted section covers.
              background: 'var(--mrx-surface-base)',
            }}
          >
            {open ? <Measured sectionKey={key} onHeight={report}>{children(item, index, true)}</Measured> : children(item, index, false)}
          </Box>
        );
      })}
    </Box>
  );
}

/** An open section, reporting its height whenever it changes. */
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
