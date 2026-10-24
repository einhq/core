import { useCallback, useEffect, useRef, useState } from 'react';
import { execCommand } from '../signals/shell-client.ts';

/**
 * Run one command and keep its answer, and run it again when the command line changes.
 *
 * For what a page reads once per visit, each part its own read: a section paints as soon as its
 * own answer is in rather than when the slowest of the page's is. A run that a newer one replaces,
 * or that is still going when the component goes, is hung up on the server, so a slow scan stops
 * instead of finishing for an answer nobody reads.
 */
export function useCommand<T>(command: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const latest = useRef<AbortController | null>(null);

  useEffect(() => () => {
    latest.current?.abort();
    latest.current = null;
  }, []);

  const refetch = useCallback(async () => {
    latest.current?.abort();
    const run = new AbortController();
    latest.current = run;
    setLoading(true);
    try {
      const answer = await execCommand<T>(command, { signal: run.signal });
      if (run !== latest.current) return;
      setData(answer);
      setError(null);
    } catch (err) {
      if (run !== latest.current) return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (run === latest.current) setLoading(false);
    }
  }, [command]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, loading, error, refetch };
}
