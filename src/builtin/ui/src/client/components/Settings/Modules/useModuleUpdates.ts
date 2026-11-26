import { useCallback, useEffect, useState } from 'react';
import type { ModuleEntry, ModuleOutdated, OutdatedModule } from '@ein/api';
import { execCommand } from '../../../signals/shell-client.ts';

/** Another module an update takes along: its name, what it goes to, and what `mod install` is given for it. */
type UpdatedWith = { name: string; to: string; target: string };

/** What updating one module would do, as far as `mod outdated` has said. */
export type ModuleUpdate =
  | { state: 'checking' }
  /**
   * There is a newer release, or a newer commit of its branch or tag: `to` is its version, or its
   * commit cut short when the version is the same. `targets` are what `mod install` is given: its
   * own, then those of the modules updated with it (`together`); `held` says each range the update
   * leaves unmet even so.
   */
  | { state: 'behind'; to: string; targets: string[]; together: UpdatedWith[]; held: string[] }
  | { state: 'latest' }
  /** Its repository did not answer, or the check failed: Update still tries. */
  | { state: 'unknown'; reason: string };

/** What a module behind goes to: its version, or its commit cut short when the version is the same. */
export const updateTo = (module: OutdatedModule): string =>
  module.latest.version && module.latest.version !== module.version ? module.latest.version : module.latest.commit.slice(0, 9);

/**
 * `mod outdated` for every installed module, asked once when the tab opens and again with
 * `refresh`, after an install ends; nothing is asked when `enabled` is false, for anyone but the
 * administrator, who alone updates. `updateOf` says where one module stands; `answer` is the whole
 * answer, `checkedAt` when it came (epoch ms).
 */
export function useModuleUpdates(enabled: boolean) {
  const [answer, setAnswer] = useState<ModuleOutdated | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [asked, setAsked] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const run = new AbortController();
    setLoading(true);
    execCommand<ModuleOutdated>('mod outdated', { signal: run.signal })
      .then((next) => {
        setAnswer(next);
        setCheckedAt(Date.now());
        setError(null);
      })
      .catch((err) => {
        if (!run.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!run.signal.aborted) setLoading(false);
      });
    return () => run.abort();
  }, [enabled, asked]);

  const refresh = useCallback(() => setAsked((count) => count + 1), []);

  const updateOf = (module: ModuleEntry): ModuleUpdate => {
    const found = answer?.modules.find((each) => each.name === module.name);
    // An answer from before this module was installed again says nothing of what is installed now.
    if (found && found.commit === module.installed?.commit) {
      if (!found.behind) return { state: 'latest' };
      const together = (found.together ?? []).flatMap((name): UpdatedWith[] => {
        const other = answer?.modules.find((each) => each.name === name);
        return other ? [{ name, to: updateTo(other), target: other.target }] : [];
      });
      return { state: 'behind', to: updateTo(found), targets: [found.target, ...together.map((each) => each.target)], together, held: found.held ?? [] };
    }
    if (loading) return { state: 'checking' };
    const failed = answer?.failed.find((each) => each.name === module.name);
    return { state: 'unknown', reason: failed?.reason ?? error ?? 'not checked' };
  };

  return { updateOf, refresh, answer, loading, error, checkedAt };
}
