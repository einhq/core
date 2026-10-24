/**
 * The administrator's view of accounts and groups: what state an account is in, how it belongs
 * to a group, the order lists are shown in, and the plain words for the settings that govern new
 * accounts and sign-in sessions. The server decides all of it; this only has to draw it.
 */

import type { GroupEntry, GroupRole, SessionEntry, UserEntry } from '@ein/api';

type AccountStatus = 'active' | 'disabled' | 'needs-password';

/**
 * Whether an account can sign in: `disabled` first, then `needs-password` when no password is set
 * or a reset is pending. The guest is never waiting for a password: it has none by design.
 */
export const accountStatus = (user: UserEntry): AccountStatus => {
  if (user.inactive) return 'disabled';
  if (user.role !== 'guest' && (user.mustResetPassword || user.hasPassword === false)) return 'needs-password';
  return 'active';
};

/** The title, or the account's or group's name when it has none. */
export const displayName = (entry: UserEntry | GroupEntry): string => entry.title?.trim() || ('username' in entry ? entry.username : entry.groupname);

/** A picker's option: `Anna Andersson (anna)`, or the name alone when it has no other title. */
export const accountOption = (entry: UserEntry | GroupEntry): { value: string; label: string } => {
  const name = 'username' in entry ? entry.username : entry.groupname;
  const title = displayName(entry);
  return { value: name, label: title === name ? name : `${title} (${name})` };
};

type Membership = 'automatic' | 'primary' | 'member' | 'none';

/**
 * How `user` belongs to `group`:
 * - `automatic`: the `everyone` group, which every account that signs in is in; never the guest,
 *   whose sessions carry only its own group;
 * - `primary`: its primary group, which counts without a membership link (and with one);
 * - `member`: linked into the group;
 * - `none`.
 */
export const membershipOf = (user: UserEntry, group: GroupEntry): Membership => {
  if (group.role === 'everyone') return user.role === 'guest' ? 'none' : 'automatic';
  if (user.gid === group.gid) return 'primary';
  if (group.members?.includes(user.username)) return 'member';
  return 'none';
};

const isOwnGroup = (group: GroupEntry, user: UserEntry): boolean => group.groupname === user.username && group.gid === user.uid;

/**
 * Whether `group` is some account's own: named as the account, with its uid as gid, the way
 * `user-create` makes one per account. A built-in group never is, although `admin` and `guest`
 * match the rule.
 */
export const isPersonalGroup = (group: GroupEntry, users: UserEntry[]): boolean => !group.role && users.some((user) => isOwnGroup(group, user));

/** The account's own group (see `isPersonalGroup`), when it has one. */
export const personalGroupOf = (user: UserEntry, groups: GroupEntry[]): GroupEntry | undefined => groups.find((group) => !group.role && isOwnGroup(group, user));

const byName = (a: UserEntry | GroupEntry, b: UserEntry | GroupEntry): number => displayName(a).localeCompare(displayName(b));

const userRank = (user: UserEntry): number => (user.role === 'administrator' ? 0 : user.role === 'guest' ? 2 : 1);

/** Accounts by display name, the administrator first and the guest last. */
export const sortUsers = (users: UserEntry[]): UserEntry[] => [...users].sort((a, b) => userRank(a) - userRank(b) || byName(a, b));

const GROUP_ROLES: GroupRole[] = ['administrators', 'everyone', 'ssh', 'sudo', 'guests'];

const groupRank = (group: GroupEntry): number => (group.role ? GROUP_ROLES.indexOf(group.role) : GROUP_ROLES.length);

/** Groups by display name, after the built-in ones in the order `admin`, `users`, `ssh`, `sudo`, `guest`. */
export const sortGroups = (groups: GroupEntry[]): GroupEntry[] => [...groups].sort((a, b) => groupRank(a) - groupRank(b) || byName(a, b));

/** The open sessions (`who`) of `user`; it is signed in now when there is any. */
export const signedIn = (user: UserEntry, sessions: SessionEntry[]): SessionEntry[] => sessions.filter((session) => session.uid === user.uid);

/**
 * What a new account's `user-create --groups` lists: the groups picked on the form, then the
 * default groups the form did not offer as a choice, each once. A default the form showed and the
 * administrator unticked stays out.
 */
export const newUserGroups = (defaults: string[], shown: string[], selected: string[]): string[] => [
  ...new Set([...selected, ...defaults.filter((name) => !shown.includes(name))]),
];

/** `'users, family'` → `['users', 'family']`: a comma list of group names, each once. */
export const parseGroupList = (value: string): string[] => [...new Set(value.split(',').map((name) => name.trim()).filter(Boolean))];

/** `['users', 'family']` → `'users,family'`. */
export const formatGroupList = (names: string[]): string => names.join(',');

const UNITS: [name: string, seconds: number][] = [['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];

/**
 * A number of seconds in words, exactly: `1 day`, `12 hours`, `2 days 6 hours`. One of a unit with
 * something left over is said in the next unit down, as people say it: `90 seconds`, `36 hours`.
 * Empty for a value that is not a duration.
 */
export function humanDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  let rest = Math.round(seconds);
  if (rest === 0) return '0 seconds';

  let first = UNITS.findIndex(([, size]) => rest >= size);
  if (first < UNITS.length - 1 && Math.floor(rest / UNITS[first][1]) === 1 && rest % UNITS[first][1] !== 0) first++;

  const parts: string[] = [];
  for (const [name, size] of UNITS.slice(first)) {
    const count = Math.floor(rest / size);
    rest -= count * size;
    if (count > 0) parts.push(`${count} ${name}${count === 1 ? '' : 's'}`);
  }
  return parts.join(' ');
}
