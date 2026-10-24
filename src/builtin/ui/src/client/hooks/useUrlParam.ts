import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * A piece of view state kept in the URL's `?<key>=`, so a reload or a shared link shows the same.
 *
 * Empty means unset: the parameter is dropped. Changes replace the history entry rather than
 * push one, so typing into a filter does not fill the way back; other parameters are kept.
 * The value is held in React state and mirrored to the URL, because the URL updates a render
 * later: an input fed straight from it loses keystrokes typed in between. A URL changed from
 * elsewhere, by a link or the way back, is taken over.
 */
export function useUrlParam(key: string): [string, (value: string) => void] {
  const [params, setParams] = useSearchParams();
  const inUrl = params.get(key) ?? '';
  const [value, setLocal] = useState(inUrl);
  const written = useRef(inUrl);

  useEffect(() => {
    if (inUrl === written.current) return;
    written.current = inUrl;
    setLocal(inUrl);
  }, [inUrl]);

  const setValue = useCallback((next: string) => {
    setLocal(next);
    written.current = next;
    setParams((current) => {
      const updated = new URLSearchParams(current);
      if (next) updated.set(key, next);
      else updated.delete(key);
      return updated;
    }, { replace: true, preventScrollReset: true });
  }, [key, setParams]);

  return [value, setValue];
}
