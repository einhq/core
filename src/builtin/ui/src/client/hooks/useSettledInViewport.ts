import { useInViewport } from '@mantine/hooks';
import { useEffect, useState } from 'react';

/**
 * Whether an element has stayed in the viewport for `settleMs`, and stays so
 * once it has.
 *
 * For what a long list loads per row. `useInViewport` alone turns on for every
 * row a fast scroll passes, and each of those queues a fetch ahead of the rows
 * where the scroll stops; a row that has to stay put first is one somebody is
 * looking at. Once settled it does not turn off: what it loaded is loaded.
 */
export function useSettledInViewport<T extends HTMLElement = HTMLElement>(settleMs: number) {
  const { ref, inViewport } = useInViewport<T>();
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (settled || !inViewport) return;
    const timer = setTimeout(() => setSettled(true), settleMs);
    return () => clearTimeout(timer);
  }, [inViewport, settled, settleMs]);

  return { ref, settled };
}
