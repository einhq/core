import { useEffect, useRef, useState } from 'react';
import { type NodeEventFilter, type NodeEventMessage, shellClientEpoch, subscribeNodes } from '../signals/shell-client.ts';

/**
 * Live VFS events, and a refresh that events can drive: the server pushes node events over
 * the socket it already has, so nothing is fetched while nothing is happening.
 */

/** Handlers sharing one server subscription, keyed by the filter's identity. */
type Pool = {
  handlers: Set<(event: NodeEventMessage) => void>;
  dispose?: () => void;
  /** Epoch the live subscription belongs to; a reconnect invalidates it. */
  epoch: number;
};

const pools = new Map<string, Pool>();

/**
 * Subscribe to node events under `filter`.
 *
 * N mounted components sharing a filter cost one server subscription: the
 * dashboard, its pipeline table and its activity list all watch the same
 * subtree, and there is no reason for three.
 */
export function useNodeEvents(filter: NodeEventFilter, onEvent: (event: NodeEventMessage) => void): void {
  const key = JSON.stringify(filter);
  // Kept in a ref so a caller passing an inline arrow doesn't tear down and
  // rebuild the server subscription on every render.
  const handler = useRef(onEvent);
  handler.current = onEvent;

  const epoch = shellClientEpoch.value;

  useEffect(() => {
    const dispatch = (event: NodeEventMessage) => handler.current(event);

    let pool = pools.get(key);
    if (!pool || pool.epoch !== epoch) {
      // A reconnect mints new subscription ids server-side, so the old pool's
      // dispose is meaningless — drop it and subscribe afresh.
      pool?.dispose?.();
      pool = { handlers: new Set(), epoch };
      pools.set(key, pool);

      const owned = pool;
      subscribeNodes(filter, (event) => {
        for (const fn of owned.handlers) fn(event);
      }).then((dispose) => {
        // Unsubscribed (or reconnected) before the subscribe resolved.
        if (pools.get(key) !== owned) dispose();
        else owned.dispose = dispose;
      }).catch(() => {
        // Socket down. The epoch bump on reconnect retries this.
      });
    }

    pool.handlers.add(dispatch);

    return () => {
      const current = pools.get(key);
      if (!current) return;
      current.handlers.delete(dispatch);
      if (current.handlers.size === 0) {
        pools.delete(key);
        current.dispose?.();
      }
    };
    // `filter` is captured through `key`, which is its serialization.
  }, [key, epoch]);
}

/**
 * Fetch `load()` once, then again whenever `bump()` is called — at most once
 * per `minIntervalMs`, and never concurrently with itself.
 *
 * Counts cannot be maintained from events directly: an event carries the node's
 * new status but not its previous one, so a running -> completed transition
 * cannot be applied as a delta without knowing where to decrement. Refetching a
 * cheap aggregate is exact; this just keeps a burst of events from refetching
 * once per event. Row-level views patch from event attrs instead and don't
 * need this.
 *
 * A new `load` — the caller's `useCallback` over a changed filter — loads again
 * at once, so `load` must be memoized. A result that arrives for a `load` since
 * replaced is dropped, and the replacement runs as soon as the old one is done.
 */
export function useEventDrivenData<T>(
  load: () => Promise<T>,
  minIntervalMs = 2000,
): { data: T | null; loading: boolean; error: Error | null; bump: () => void; refetch: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const loadRef = useRef(load);
  loadRef.current = load;

  const inFlight = useRef(false);
  // A run was asked for while one was in flight, for a `load` that has since changed.
  const rerun = useRef(false);
  const lastRun = useRef(0);
  const trailing = useRef<number | null>(null);
  const mounted = useRef(true);

  const epoch = shellClientEpoch.value;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (trailing.current !== null) globalThis.clearTimeout(trailing.current);
    };
  }, []);

  const run = useRef(async () => {
    if (inFlight.current) {
      rerun.current = true;
      return;
    }
    inFlight.current = true;
    lastRun.current = Date.now();
    const current = loadRef.current;
    try {
      const result = await current();
      if (!mounted.current || current !== loadRef.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (!mounted.current || current !== loadRef.current) return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      inFlight.current = false;
      if (mounted.current && current === loadRef.current) setLoading(false);
      if (mounted.current && (rerun.current || current !== loadRef.current)) {
        rerun.current = false;
        run.current();
      }
    }
  });

  const bump = useRef(() => {
    const since = Date.now() - lastRun.current;
    if (since >= minIntervalMs && !inFlight.current) {
      run.current();
      return;
    }
    // Trailing edge: the burst that is arriving now still has to be reflected,
    // just not once per event.
    if (trailing.current !== null) return;
    trailing.current = globalThis.setTimeout(() => {
      trailing.current = null;
      run.current();
    }, Math.max(0, minIntervalMs - since));
  });

  // Initial load, and a resync after every reconnect — a new socket means an
  // unknown amount of missed traffic, so what is on screen cannot be trusted.
  useEffect(() => {
    run.current();
  }, [epoch, load]);

  return { data, loading, error, bump: bump.current, refetch: run.current };
}
