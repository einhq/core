import { useCallback, useEffect, useState } from 'react';
import { execCommand } from '../signals/shell-client.ts';
import { type ConfigEntry, loadUserConfig } from '../signals/config.ts';
import { shq } from '../lib/shquote.ts';

export type SaveResult = {
  ok: boolean;
  key: string;
  value: string;
  scope: 'system' | 'user';
  restarted: string[];
  failed: { name: string; error: string }[];
  restartNote?: string;
};

export type UseConfigResult = {
  entries: ConfigEntry[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
  /** Write one setting. Resolves with what the server restarted, if anything. */
  save: (key: string, value: string) => Promise<SaveResult>;
  /** Clear one setting, so it falls back to the deployment or the default. */
  reset: (key: string) => Promise<SaveResult>;
};

/**
 * The settings table with each entry's effective value.
 *
 * `scope` narrows it to one half; the system settings page asks for `system`
 * and the profile page for `user`, so neither renders fields it cannot write.
 */
export function useConfig(scope?: 'system' | 'user'): UseConfigResult {
  const [entries, setEntries] = useState<ConfigEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    try {
      setError(null);
      const result = await execCommand<ConfigEntry[]>(`config list${scope ? ` --scope ${scope}` : ''}`);
      setEntries(result ?? []);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const write = useCallback(async (command: string): Promise<SaveResult> => {
    const result = await execCommand<SaveResult>(command);
    await refetch();
    // Anything a component reads straight off the signal — the slideshow
    // timing, the Ken Burns flag — would otherwise stay on the old value until
    // the page was reloaded.
    await loadUserConfig();
    return result;
  }, [refetch]);

  const save = useCallback(
    (key: string, value: string) => write(`config set ${shq(key)} ${shq(value)}`),
    [write],
  );

  const reset = useCallback((key: string) => write(`config unset ${shq(key)}`), [write]);

  return { entries, loading, error, refetch, save, reset };
}
