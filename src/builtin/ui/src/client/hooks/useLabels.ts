import { useCallback, useEffect, useState } from 'react';
import { execCommand } from '../signals/shell-client.ts';
import type { LabelEntry } from '@ein/api';
export type { LabelEntry } from '@ein/api';

export type UseLabelsResult = {
  labels: LabelEntry[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
};

/**
 * The global label registry — every child of `/tags` with its member count, by name.
 */
export function useLabels(): UseLabelsResult {
  const [labels, setLabels] = useState<LabelEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchLabels = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const entries = await execCommand<LabelEntry[]>('label list');
      setLabels((entries ?? []).toSorted((a, b) => a.label.localeCompare(b.label)));
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setLabels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLabels();
  }, [fetchLabels]);

  return { labels, loading, error, refetch: fetchLabels };
}
