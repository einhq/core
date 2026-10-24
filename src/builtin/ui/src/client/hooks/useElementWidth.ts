import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The content-box width of an element, as a whole number of pixels.
 *
 * Deliberately not Mantine's `useResizeObserver`: that re-renders on every fractional
 * change, and a justified grid re-laid out at 999.6px then 1000px then 999.6px flickers
 * — a scrollbar appearing at the bottom of a page is enough to start that loop. Flooring
 * and skipping unchanged widths makes the layout a step function instead.
 *
 * Returns a ref callback rather than a ref object so the observer attaches the moment the
 * node mounts, without an extra render to notice it.
 */
export function useElementWidth<T extends HTMLElement>(): [(node: T | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: T | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;

    if (!node) return;

    setWidth((prev) => {
      const next = Math.floor(node.getBoundingClientRect().width);
      return next === prev ? prev : next;
    });

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const next = Math.floor(entry.contentRect.width);
      setWidth((prev) => (next === prev ? prev : next));
    });

    observer.observe(node);
    observerRef.current = observer;
  }, []);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return [ref, width];
}
