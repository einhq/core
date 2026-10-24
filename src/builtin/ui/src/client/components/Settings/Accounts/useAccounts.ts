import { useCallback, useEffect, useRef } from 'react';
import type { GroupEntry, SessionEntry, UserEntry } from '@ein/api';
import { GROUPS_PATH, USERS_PATH } from '@ein/paths';
import { reloadIdentities } from '../../../hooks/useIdentities.ts';
import { useEventDrivenData, useNodeEvents } from '../../../hooks/useNodeEvents.ts';
import { execCommand, type NodeEventFilter } from '../../../signals/shell-client.ts';
import { sortGroups, sortUsers } from '../../../lib/accounts.ts';

type Lists = { users: UserEntry[]; groups: GroupEntry[] };

const NONE: Lists = { users: [], groups: [] };

const loadLists = async (): Promise<Lists> => {
  const [users, groups] = await Promise.all([
    execCommand<UserEntry[]>('user-list'),
    execCommand<GroupEntry[]>('group-list --members'),
  ]);
  return { users: sortUsers(users ?? []), groups: sortGroups(groups ?? []) };
};

const NO_SESSIONS: SessionEntry[] = [];

/** Who is signed in now. The lists stand without it, so a failure is nobody. */
const loadSessions = async (): Promise<SessionEntry[]> => (await execCommand<SessionEntry[]>('who').catch(() => null)) ?? [];

/** An account's own node is `<USERS_PATH>/<username>`; a password set or removed is a child of it. */
const USER_EVENTS: NodeEventFilter = { pathPrefix: USERS_PATH, recursive: false, nodeTypes: ['user'] };
/** A group's node, and under it a link per member. */
const GROUP_EVENTS: NodeEventFilter = { pathPrefix: GROUPS_PATH, recursive: true };

/** How often who is signed in is asked again while the window is in view. */
const SESSIONS_EVERY_MS = 30_000;

export type Accounts = {
  /** Every account, in display order (`sortUsers`). */
  users: UserEntry[];
  /** Every group with its linked members, in display order (`sortGroups`). */
  groups: GroupEntry[];
  /** The sessions open now; empty when they cannot be listed. */
  sessions: SessionEntry[];
  loading: boolean;
  error: Error | null;
  /**
   * Run one command that changes accounts or groups and answer with what it printed, once the
   * lists loaded after it are drawn, and the pickers of every `useIdentities()` have it too. A
   * failure is thrown on, for the caller to show where the action was.
   */
  run: <T = unknown>(command: string) => Promise<T>;
};

/**
 * Every account and group, and who is signed in, for the administrator's Users and Groups tabs.
 * The accounts and groups load again on any change to them, a terminal's included, and when the
 * window regains focus. Who is signed in has no node events to follow, since a shell opens and
 * closes without one: it is asked again on focus, every 30 seconds while the window is in view,
 * and after every `run`.
 */
export function useAccounts(): Accounts {
  // Loads of the lists started so far, the newest one settled, and the `run`s waiting for one that
  // started after their command.
  const started = useRef(0);
  const settled = useRef(0);
  const waiting = useRef<{ after: number; resolve: () => void }[]>([]);

  const load = useCallback(async () => {
    const number = ++started.current;
    try {
      return await loadLists();
    } finally {
      // Loads never overlap (`useEventDrivenData`), so they settle in the order they started.
      settled.current = number;
    }
  }, []);

  const lists = useEventDrivenData(load);
  const presence = useEventDrivenData(loadSessions);
  useNodeEvents(USER_EVENTS, lists.bump);
  useNodeEvents(GROUP_EVENTS, lists.bump);

  // Once a load's lists, or its failure, are drawn, the runs waiting for that load go on.
  useEffect(() => {
    waiting.current = waiting.current.filter((wait) => {
      if (wait.after >= settled.current) return true;
      wait.resolve();
      return false;
    });
  }, [lists.data, lists.error]);

  useEffect(() => () => {
    for (const wait of waiting.current) wait.resolve();
    waiting.current = [];
  }, []);

  useEffect(() => {
    const onFocus = () => {
      lists.bump();
      presence.bump();
    };
    const timer = globalThis.setInterval(() => {
      if (!document.hidden) presence.bump();
    }, SESSIONS_EVERY_MS);
    globalThis.addEventListener('focus', onFocus);
    return () => {
      globalThis.clearInterval(timer);
      globalThis.removeEventListener('focus', onFocus);
    };
  }, [lists.bump, presence.bump]);

  const { refetch: refetchLists } = lists;
  const { refetch: refetchSessions } = presence;
  const run = useCallback(async <T = unknown>(command: string): Promise<T> => {
    try {
      return await execCommand<T>(command);
    } finally {
      // Also after a failure, which may have changed part of what it was asked to. A load already
      // under way may have read before the change, so this waits for one that starts after it,
      // which `refetch` starts at once or as soon as that one is done.
      const landed = new Promise<void>((resolve) => waiting.current.push({ after: started.current, resolve }));
      void refetchLists();
      void refetchSessions();
      await Promise.all([landed, reloadIdentities()]);
    }
  }, [refetchLists, refetchSessions]);

  const { users, groups } = lists.data ?? NONE;
  return { users, groups, sessions: presence.data ?? NO_SESSIONS, loading: lists.loading, error: lists.error, run };
}
