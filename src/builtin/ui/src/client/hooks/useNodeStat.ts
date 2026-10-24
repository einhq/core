import { useCallback, useEffect, useState } from 'react';
import { shq } from '../lib/shquote.ts';
import { execCommand } from '../signals/shell-client.ts';
import type { ShareInfo } from './useShare.ts';

/** What `stat -L` returns: the node itself, links included. */
export type StatNode = {
  id: string;
  type: string;
  props: {
    uid: number;
    gid: number;
    mode: number;
    count: number;
    softlink?: string;
    tier?: string;
    acl?: { mode: number; uid?: number; gid?: number }[];
    birthtime: { uid: number; timestamp: number | string };
    changetime: { uid: number; timestamp: number | string };
    modtime: { uid: number; timestamp: number | string };
  };
  attrs: Record<string, unknown>;
};

export type NodeStat = { node: StatNode; share: ShareInfo | null };

/**
 * A node's full record for the properties panel, plus what `share-info`
 * adds: names for the ids, and the server's own answer to "may I edit this",
 * which sees access-list grants the client-side check cannot.
 */
export function useNodeStat(
  path: string | null,
): { stat: NodeStat | null; statPath: string | null; loading: boolean; error: Error | null; refetch: () => void } {
  const [stat, setStat] = useState<NodeStat | null>(null);
  // The last answer stays while the next path loads; this says whose it is.
  const [statPath, setStatPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!path) {
      setStat(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all([
      execCommand<StatNode>(`stat -L ${shq(path)}`),
      execCommand<ShareInfo>(`share-info ${shq(path)}`).catch(() => null),
    ]).then(([node, share]) => {
      if (cancelled) return;
      setStat({ node, share });
      setStatPath(path);
      setError(null);
    }).catch((err) => {
      if (cancelled) return;
      setStat(null);
      setStatPath(null);
      setError(err instanceof Error ? err : new Error(String(err)));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [path, tick]);

  const refetch = useCallback(() => setTick((n) => n + 1), []);
  return { stat, statPath, loading, error, refetch };
}
