import { useCallback, useEffect, useRef } from 'react';
import type { ScrollRoot } from './usePrependHold.ts';

/**
 * A ref for an element after the last result that calls `loadMore` as it nears
 * the viewport — infinite scroll, in place of a "load more" button.
 *
 * The observer is recreated whenever paging state changes, so its callback
 * always closes over a current `loadMore`, and a sentinel still in view after a
 * page lands fires again and keeps paging until the list fills past it.
 *
 * Callers pass `hasMore && !error`: a failed page keeps its cursor, and a
 * sentinel still in view would otherwise retry it in a tight loop.
 */
export function useLoadMoreSentinel(hasMore: boolean, loading: boolean, loadMore: () => void, scrollRoot: ScrollRoot = null) {
  const observerRef = useRef<IntersectionObserver | null>(null);
  const sentinelRef = useCallback((node: HTMLElement | null) => {
    observerRef.current?.disconnect();
    if (!node || !hasMore || loading) return;

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore();
    }, { root: scrollRoot, rootMargin: '600px' });

    observer.observe(node);
    observerRef.current = observer;
  }, [hasMore, loading, loadMore, scrollRoot]);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return sentinelRef;
}
