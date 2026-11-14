import { useCallback, useEffect, useState } from 'react';
import type { ConfigWriteAnswer } from '@ein/api';
import { execCommand } from '../signals/shell-client.ts';
import { type ConfigEntry, loadUserConfig } from '../signals/config.ts';
import { shq } from '../lib/shquote.ts';

/** What saving or restoring one setting did: its value in force now, and what was restarted for it. */
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
  /**
   * Write several settings in one command: all or none are written, and a service that reads any
   * of them restarts once. For what belongs together, such as an address and the key sent to it.
   */
  saveAll: (values: Record<string, string>) => Promise<ConfigWriteAnswer>;
  /** Clear several settings in one command, as `saveAll` writes them. */
  resetAll: (keys: string[]) => Promise<ConfigWriteAnswer>;
};

/** One setting's part of an answer, as `save` and `reset` give it. */
const oneSetting = (answer: ConfigWriteAnswer): SaveResult => {
  const [{ key, value, scope }] = answer.settings;
  return { ok: answer.ok, key, value, scope, restarted: answer.restarted, failed: answer.failed, restartNote: answer.notes[0] };
};

/** Every `useConfig` on the page, told to read the table again after any of them writes. */
const readers = new Set<() => Promise<void>>();

/**
 * The settings table with each entry's effective value.
 *
 * `scope` narrows it to one half; the system settings page asks for `system`
 * and the profile page for `user`, so neither renders fields it cannot write.
 * A write through one reads the table again in every one on the page, so a
 * settings view and the list beside it never disagree.
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
    readers.add(refetch);
    return () => void readers.delete(refetch);
  }, [refetch]);

  const write = useCallback(async (command: string): Promise<ConfigWriteAnswer> => {
    const result = await execCommand<ConfigWriteAnswer>(command);
    await Promise.all([...readers].map((read) => read()));
    // Anything a component reads straight off the signal — the slideshow
    // timing, the Ken Burns flag — would otherwise stay on the old value until
    // the page was reloaded.
    await loadUserConfig();
    return result;
  }, []);

  const save = useCallback((key: string, value: string) => write(`config set ${shq(key)} ${shq(value)}`).then(oneSetting), [write]);

  const reset = useCallback((key: string) => write(`config unset ${shq(key)}`).then(oneSetting), [write]);

  const saveAll = useCallback(
    (values: Record<string, string>) => write(`config set ${Object.entries(values).map(([key, value]) => shq(`${key}=${value}`)).join(' ')}`),
    [write],
  );

  const resetAll = useCallback((keys: string[]) => write(`config unset ${keys.map(shq).join(' ')}`), [write]);

  return { entries, loading, error, refetch, save, reset, saveAll, resetAll };
}
