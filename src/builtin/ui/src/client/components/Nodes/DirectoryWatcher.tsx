import { useEffect, useRef } from 'react';
import { useNodeEvents } from '../../hooks/useNodeEvents.ts';

const SETTLE_MS = 800;

/**
 * Reloads a directory when anything directly under it changes.
 *
 * Renders nothing; it exists so a tree can hold one subscription per open
 * directory by rendering one of these per open directory, and drop them as
 * rows collapse. A burst — an import writing a hundred files — collapses into
 * one reload at the trailing edge rather than a hundred.
 */
export function DirectoryWatcher({ path, onChange }: { path: string; onChange: (path: string) => void }) {
  const timer = useRef<number | null>(null);
  const latest = useRef(onChange);
  latest.current = onChange;

  useNodeEvents({ pathPrefix: path, recursive: false }, () => {
    if (timer.current !== null) return;
    timer.current = globalThis.setTimeout(() => {
      timer.current = null;
      latest.current(path);
    }, SETTLE_MS);
  });

  useEffect(() => () => {
    if (timer.current !== null) globalThis.clearTimeout(timer.current);
  }, []);

  return null;
}
