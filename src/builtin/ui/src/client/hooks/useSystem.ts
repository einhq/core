import { useCallback, useEffect, useRef, useState } from 'react';
import { execCommand } from '../signals/shell-client.ts';

/** How often the host metrics refresh. The sampler writes every 15s; this is well inside that. */
const POLL_MS = 10_000;

/**
 * Run one command now and again `everyMs` after each answer (10 s unless told), keeping its latest
 * answer. `nextIn`, when given, makes the wait from the answer instead: an answer kept by the server
 * for a while can say when it is next new, so the card asks just then rather than at its own pace and
 * gets an answer as old as the server keeps one, not up to twice that. Where `nextIn` says nothing,
 * as for a failed run, the wait is `everyMs`.
 *
 * For numbers that change on a clock with no node event behind them — host metrics, disk,
 * services — so there is nothing to subscribe to. The system dashboard runs one of these per
 * card, so each card appears as soon as its own answer is in rather than when the slowest one's
 * is.
 *
 * Asking stops while the tab is hidden — a dashboard left open on a second monitor overnight
 * would otherwise run 8,640 execs to draw frames nobody sees — and while `enabled` is false,
 * which is how a dashboard tab nobody has open stops costing anything. The last answer is kept
 * while disabled, so coming back to a tab shows it at once and refreshes it. A new command keeps
 * the last answer until its own is in, and is asked at once even while the old one is still running.
 */
export function usePolledCommand<T>(
  command: string,
  enabled = true,
  everyMs = POLL_MS,
  nextIn?: (answer: T) => number | undefined,
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Guards against a slow response overlapping the next ask.
  const inFlight = useRef(false);
  // The command and refetch of the latest render, for a command that changed while another ran.
  const wanted = useRef({ command, enabled });
  wanted.current = { command, enabled };
  const latest = useRef<() => Promise<void>>(async () => {});
  // The latest render's, so a `nextIn` written inline does not restart the asking.
  const nextOf = useRef(nextIn);
  nextOf.current = nextIn;

  /** The answer, or nothing when the run failed or another was still under way. */
  const ask = useCallback(async (): Promise<T | undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    let answer: T | undefined;
    try {
      answer = await execCommand<T>(command);
      setData(answer);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
    // The command changed while this one ran, and its own first call was turned away: it runs now
    // rather than at the next ask.
    if (wanted.current.enabled && wanted.current.command !== command) await latest.current();
    return answer;
  }, [command]);
  const refetch = useCallback(async () => {
    await ask();
  }, [ask]);
  latest.current = refetch;

  useEffect(() => {
    if (!enabled) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    // Each start of the asking counts one up, so only the latest one goes on asking.
    let round = 0;
    const start = async () => {
      clearTimeout(timer);
      const mine = ++round;
      if (document.hidden) return;
      const answer = await ask();
      if (mine !== round) return;
      const wait = answer === undefined ? undefined : nextOf.current?.(answer);
      timer = setTimeout(start, wait ?? everyMs);
    };
    start();

    // Coming back to the tab should show current numbers, not the last frame
    // from before it was hidden.
    const onVisible = () => {
      if (!document.hidden) start();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      round++;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ask, enabled, everyMs]);

  return { data, loading, error, refetch };
}
