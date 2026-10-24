import { useCallback, useEffect, useRef, useState } from 'react';
import { execCommand } from '../signals/shell-client.ts';

/** How often the host metrics refresh. The sampler writes every 15s; this is well inside that. */
const POLL_MS = 10_000;

/**
 * Run one command now and every 10s after, keeping its latest answer.
 *
 * For numbers that change on a clock with no node event behind them — host metrics, disk,
 * services — so there is nothing to subscribe to. The system dashboard runs one of these per
 * card, so each card appears as soon as its own answer is in rather than when the slowest one's
 * is.
 *
 * The timer stops while the tab is hidden — a dashboard left open on a second monitor overnight
 * would otherwise run 8,640 execs to draw frames nobody sees — and while `enabled` is false,
 * which is how a dashboard tab nobody has open stops costing anything. The last answer is kept
 * while disabled, so coming back to a tab shows it at once and refreshes it.
 */
export function usePolledCommand<T>(command: string, enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Guards against a slow response overlapping the next tick.
  const inFlight = useRef(false);

  const refetch = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await execCommand<T>(command);
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [command]);

  useEffect(() => {
    if (!enabled) return;

    const tick = () => {
      if (!document.hidden) refetch();
    };

    refetch();
    const timer = setInterval(tick, POLL_MS);

    // Coming back to the tab should show current numbers, not the last frame
    // from before it was hidden.
    const onVisible = () => {
      if (!document.hidden) refetch();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refetch, enabled]);

  return { data, loading, error, refetch };
}
