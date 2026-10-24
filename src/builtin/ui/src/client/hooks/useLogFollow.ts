import { useEffect, useRef, useState } from 'react';
import { followLog, type LogFollowEntry, shellClientEpoch } from '../signals/shell-client.ts';

export type UseLogFollowOptions = {
  /** History requested on subscribe, so a view opens with context rather than blank. */
  tail: number;
  /** How many entries are kept; older ones fall off as new ones arrive. */
  keep: number;
  /** Stop appending without dropping the subscription. */
  paused?: boolean;
};

/**
 * A log node's last entries, kept live.
 *
 * Pushed, not polled: the server blocks on LISTEN/NOTIFY and sends batches down
 * the API socket the page already has. That is why this hook only makes sense
 * mounted — the subscription lives exactly as long as the component, so a view
 * that is not showing must actually unmount rather than hide, or the pump keeps
 * running server-side for a panel nobody is looking at.
 *
 * `paused` stops appending without dropping the subscription: tearing it down
 * and resubscribing would replay the tail window and reorder what the reader was
 * in the middle of reading. `null` follows nothing.
 */
export function useLogFollow(path: string | null, { tail, keep, paused = false }: UseLogFollowOptions): {
  entries: LogFollowEntry[];
  connected: boolean;
  clear: () => void;
} {
  const [entries, setEntries] = useState<LogFollowEntry[]>([]);
  const [connected, setConnected] = useState(false);

  // Read inside the batch handler, so pausing does not resubscribe.
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const epoch = shellClientEpoch.value;

  useEffect(() => {
    setEntries([]);
    if (!path) return;
    let live = true;
    let unfollow: (() => void) | undefined;

    followLog(path, (batch) => {
      if (!live || pausedRef.current) return;
      setEntries((prev) => [...prev, ...batch].slice(-keep));
    }, { tail })
      .then((dispose) => {
        // Unmounted (or reconnected) before the subscribe resolved.
        if (!live) dispose();
        else {
          unfollow = dispose;
          setConnected(true);
        }
      })
      .catch(() => {
        // Socket down. The epoch bump on reconnect retries this.
      });

    return () => {
      live = false;
      setConnected(false);
      unfollow?.();
    };
  }, [path, epoch, tail, keep]);

  return { entries, connected, clear: () => setEntries([]) };
}
