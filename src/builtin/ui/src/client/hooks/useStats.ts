import { useCallback, useEffect, useState } from 'react';
import { execCommand } from '../signals/shell-client.ts';
import type { StatsOverview } from '@ein/api';
export type { NodeTypeGrowth, StatsOverview } from '@ein/api';

/** The statistics page's own part: core's node growth. A module's sections are `stats.sections` panels. */
export type StatsPage = StatsOverview;

/** Archive statistics change slowly, so fetch once per page visit. */
export function useStatsOverview() {
  const [data, setData] = useState<StatsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      setData(await execCommand<StatsOverview>('stats-overview'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, loading, error, refetch };
}
