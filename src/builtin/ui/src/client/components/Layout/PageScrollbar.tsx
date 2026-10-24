import { useEffect, useRef } from 'react';
import { bindScrollbar } from './scrollbar.ts';

/**
 * The page's scrollbar. The browser's own is hidden (`theme.css`), so the page and the top bar
 * keep their width whether or not the page scrolls, under a dialog and beside a time rail alike.
 * This one is drawn over the page's right edge from the app header down, while the page is
 * longer than the window; a page's time rail takes its place (`.mrx-railed`). It is
 * `bindScrollbar`'s view of the page's own scroll.
 */
export function PageScrollbar() {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!track || !thumb) return;
    return bindScrollbar(track, thumb, {
      element: (document.scrollingElement ?? document.documentElement) as HTMLElement,
      events: globalThis,
      // The page's length is the body's.
      watch: (changed) => {
        const observer = new ResizeObserver(changed);
        observer.observe(document.body);
        return () => observer.disconnect();
      },
    });
  }, []);

  return (
    <div ref={trackRef} className='mrx-scrollbar mrx-page-scrollbar' aria-hidden>
      <div ref={thumbRef} className='mrx-scrollbar-thumb' />
    </div>
  );
}
