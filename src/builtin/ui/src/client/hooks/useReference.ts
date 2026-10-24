import { useCallback, useEffect, useState } from 'react';
import { execCommand } from '../signals/shell-client.ts';
import { shq } from '../lib/shquote.ts';
import type { EnvReference, NodeTypeReference } from '@ein/api';
import type { CommandFind, CommandHit } from '@ein/api';
import type { ListedCommand as CommandReference } from '@ein/api';
import type { ModuleEntry as ModuleReference } from '@ein/api';
export type { ModuleEntry as ModuleReference } from '@ein/api';
export type { CommandHit } from '@ein/api';
export type { ListedCommand as CommandReference } from '@ein/api';
export type { CmdSpec as CommandSpec, EnvReference, NodeTypeReference } from '@ein/api';

type Loaded<T> = { data: T | null; loading: boolean; error: Error | null; refetch: () => void };

/**
 * One answer per command for the life of the page, shared by every docs page that asks: the
 * command list is a few hundred specs and moving from Commands to a module should not ask again.
 */
const answers = new Map<string, Promise<unknown>>();

const ask = <T>(command: string, fresh = false): Promise<T> => {
  if (fresh || !answers.has(command)) {
    const pending = execCommand<T>(command);
    answers.set(command, pending);
    // A failure is not kept: the next page to ask tries again.
    pending.catch(() => answers.get(command) === pending && answers.delete(command));
  }
  return answers.get(command) as Promise<T>;
};

/** `fresh` skips the kept answer on the first ask too, for a page that shows state rather than reference. */
function useAnswer<T>(command: string | null, fresh = false): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(command !== null);
  const [error, setError] = useState<Error | null>(null);
  const [round, setRound] = useState(fresh ? 1 : 0);

  useEffect(() => {
    if (command === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    ask<T>(command, round > 0)
      .then((result) => !cancelled && setData(result))
      .catch((err) => !cancelled && setError(err instanceof Error ? err : new Error(String(err))))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [command, round]);

  const refetch = useCallback(() => setRound((n) => n + 1), []);
  return { data, loading, error, refetch };
}

/**
 * Every command on the reader's PATH with its spec and module.
 *
 * Core's command catalogue answers it (`docs commands`): the first call for a user asks each
 * command for its spec, which takes a while; after that it is kept in their home and answers at once.
 */
export function useCommandReference(): Loaded<CommandReference[]> {
  return useAnswer<CommandReference[]>('docs commands');
}

/** The commands that best fit what the query asks for, by meaning and by words; null while the query is too short. */
export function useCommandFind(query: string): Loaded<CommandHit[]> {
  const [settled, setSettled] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSettled(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const loaded = useAnswer<CommandFind>(settled.length >= 2 ? `docs find ${shq(settled)} --limit 12` : null);
  return { ...loaded, data: settled.length >= 2 ? loaded.data?.hits ?? null : null };
}

/** Every documented environment variable, with its value in the reader's shell. */
export function useEnvReference(): Loaded<EnvReference[]> {
  return useAnswer<EnvReference[]>('docs env');
}

/** Every node type, described or in use, with how many exist. */
export function useNodeTypeReference(): Loaded<NodeTypeReference[]> {
  return useAnswer<NodeTypeReference[]>('docs node-types');
}

/**
 * The installed modules. `fresh` asks again rather than reuse an answer kept since the docs were
 * first opened: a `mod setup` since then changes whether a module is working.
 */
export function useModuleReference({ fresh = false }: { fresh?: boolean } = {}): Loaded<ModuleReference[]> {
  const loaded = useAnswer<ModuleReference[]>('mod list', fresh);
  return { ...loaded, data: loaded.data ? loaded.data.toSorted((a, b) => a.name.localeCompare(b.name)) : null };
}
