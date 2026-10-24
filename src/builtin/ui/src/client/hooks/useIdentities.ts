import { useEffect, useState } from 'react';
import { execCommand } from '../signals/shell-client.ts';
import type { GroupEntry, UserEntry } from '@ein/api';
export type { GroupEntry, UserEntry } from '@ein/api';

export type Identities = { users: Map<number, string>; groups: Map<number, string> };

const EMPTY: Identities = { users: new Map(), groups: new Map() };

// Fetched once per page load and shared by every mounted hook, like access ids: users and groups
// change when an administrator makes them, not while someone is looking at a listing. The page
// that makes them calls `reloadIdentities()`.
type Loaded = { ids: Identities; users: UserEntry[]; groups: GroupEntry[] };
let cached: Loaded | null = null;
let pending: Promise<Loaded> | null = null;
const listeners = new Set<(loaded: Loaded) => void>();

async function fetchIdentities(): Promise<Loaded> {
  const [users, groups] = await Promise.all([
    execCommand<UserEntry[]>('user-list').catch(() => [] as UserEntry[]),
    execCommand<GroupEntry[]>('group-list').catch(() => [] as GroupEntry[]),
  ]);
  return {
    ids: {
      users: new Map((users ?? []).map((user) => [user.uid, user.username])),
      groups: new Map((groups ?? []).map((group) => [group.gid, group.groupname])),
    },
    users: users ?? [],
    groups: groups ?? [],
  };
}

/** Fetch and hand the result to every mounted hook; of overlapping loads, the last started wins. */
function load(): Promise<Loaded> {
  const loading: Promise<Loaded> = fetchIdentities().then((result) => {
    if (pending === loading) {
      cached = result;
      for (const listener of listeners) listener(result);
    }
    return result;
  });
  pending = loading;
  return loading;
}

/** Fetch users and groups again, for every mounted `useIdentities()`: after an account or group is made, renamed or removed. */
export async function reloadIdentities(): Promise<void> {
  await load();
}

/**
 * uid/gid → name, and the lists behind them for a picker.
 *
 * JSON `ls` reports numbers only — the names are a text-mode nicety on the
 * server — so the explorer resolves them itself, once, and again on `reloadIdentities()`.
 */
export function useIdentities(): { names: Identities; users: UserEntry[]; groups: GroupEntry[] } {
  const [state, setState] = useState(cached);

  useEffect(() => {
    listeners.add(setState);
    // A load may have landed between the first render and now.
    if (cached) setState(cached);
    else if (!pending) load();
    return () => {
      listeners.delete(setState);
    };
  }, []);

  return { names: state?.ids ?? EMPTY, users: state?.users ?? [], groups: state?.groups ?? [] };
}
