import { useSignals } from '@preact/signals-react/runtime';
import { useEffect, useReducer } from 'react';
import { onPageChange } from '../signals/module-ui.ts';
import { shownNode } from '../signals/page-subject.ts';

/**
 * The node on screen (`shownNode`), for a part drawn outside the page — a `shell.float` panel — that
 * follows it: drawn again as the page moves, the lightbox steps between pictures, or a page says
 * what it is about.
 */
export function useShownNode(): string | undefined {
  useSignals();
  const [, moved] = useReducer((count: number) => count + 1, 0);
  useEffect(() => onPageChange(moved), []);
  return shownNode();
}
