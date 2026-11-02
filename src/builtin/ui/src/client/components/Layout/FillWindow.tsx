import { Box } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { type ReactNode, useContext, useEffect, useRef } from 'react';
import { useAppHeaderHeight } from '../../hooks/useHeaderHeight.ts';
import { SurfaceContext } from '../../hooks/useSurface.ts';
import { stuckHeaderAbove, stuckHeaderHeight } from '../../signals/stuck-header.ts';

/**
 * Fills the window below the app header and the row a page header keeps stuck under it
 * (`EntityDetailHeader`), for what is worked in rather than scrolled past: a map, whose wheel and
 * drag are its own. Its children get the whole box, edge to edge.
 *
 * It opens with the page scrolled until the header is down to that row, and does not move while
 * the header shrinks: its top lies under the rest of the header, which goes up off it, so it grows
 * upward into the room. The page is just long enough for that, so scrolling back up brings the
 * header down over it again. In a dialog or drawer, under no app header, it is a box of most of the
 * window's height.
 */
export function FillWindow({ children }: { children: ReactNode }) {
  useSignals();
  const ref = useRef<HTMLDivElement>(null);
  const onPage = useContext(SurfaceContext) === null;
  const appHeader = useAppHeaderHeight();
  const above = stuckHeaderAbove.value;
  const row = stuckHeaderHeight.value;

  // Asked again when the header changes size, as it does once what its title and subtitle say has loaded.
  useEffect(() => {
    const box = ref.current;
    if (!onPage || !box || above === 0) return;
    // With the header stuck, the box's top is `above` over the foot of its row.
    const left = box.getBoundingClientRect().top - (appHeader + row - above);
    if (left > 1) globalThis.scrollBy({ top: left, behavior: 'smooth' });
  }, [onPage, appHeader, above, row]);

  return (
    <Box ref={ref} className='mrx-fill-window' mod={{ 'on-page': onPage }}>
      <Box className='mrx-fill-window-view'>{children}</Box>
    </Box>
  );
}
