import { ActionIcon, Box } from '@mantine/core';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { TablerIcon } from '../Icon/TablerIcon.tsx';

/** Pixels from an end within which the row counts as at it. */
const SLACK = 4;

/**
 * A list laid out as one row that scrolls sideways when it is wider than the page: a swipe on a
 * touch screen, and with a mouse the arrow at either end that has more beyond it, which moves most
 * of the row's width. The scrollbar is hidden. `children` are the list's items, each with
 * `role='listitem'`; they keep their own width.
 */
export function ScrollRow({ label, children }: { label: string; children: ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ before: false, after: false });

  const measure = useCallback(() => {
    const element = row.current;
    if (!element) return;
    // A few pixels short of an end is at it: snapping and fractional widths stop there.
    const before = element.scrollLeft > SLACK;
    const after = element.scrollLeft + element.clientWidth < element.scrollWidth - SLACK;
    setMore((was) => (was.before === before && was.after === after ? was : { before, after }));
  }, []);

  useEffect(() => {
    const element = row.current;
    if (!element) return;
    measure();
    // The row's own width, and its content's: items that draw themselves late widen it.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    const mutations = new MutationObserver(() => {
      for (const child of element.children) observer.observe(child);
      measure();
    });
    mutations.observe(element, { childList: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, [measure]);

  const page = (direction: 1 | -1) => row.current?.scrollBy({ left: direction * row.current.clientWidth * 0.8, behavior: 'smooth' });

  return (
    <Box className='mrx-scroll-row-frame'>
      <Box ref={row} className='mrx-scroll-row' role='list' aria-label={label} onScroll={measure}>
        {children}
      </Box>
      {more.before && (
        <ActionIcon
          className='mrx-scroll-row-arrow'
          data-side='before'
          variant='default'
          radius='xl'
          size='lg'
          aria-label='Scroll left'
          onClick={() => page(-1)}
        >
          <TablerIcon name='chevron-left' size={18} />
        </ActionIcon>
      )}
      {more.after && (
        <ActionIcon className='mrx-scroll-row-arrow' data-side='after' variant='default' radius='xl' size='lg' aria-label='Scroll right' onClick={() => page(1)}>
          <TablerIcon name='chevron-right' size={18} />
        </ActionIcon>
      )}
    </Box>
  );
}
