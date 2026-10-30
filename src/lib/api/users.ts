/**
 * What the user, group, label and module commands answer with, and the rule a new user's or
 * group's name follows.
 */

import type { GroupId, UserId } from './ids.ts';
import type { HeldShareLink } from './share.ts';

/** `user-list`: one account. */
export type UserEntry = {
  username: string;
  uid: UserId;
  /** The primary group: what the account's new nodes belong to, and a membership without a link. */
  gid: GroupId;
  /** The person's own name, when the account has one. */
  title?: string;
  /** An address the account may also sign in with instead of its username; no other account has it. */
  email?: string;
  description?: string;
  inactive: boolean;
  /** No sign-in is accepted until a password is set (`user-passwd`), which clears it. */
  mustResetPassword: boolean;
  /** Whether a password is set. Reported to an administrator only. */
  hasPassword?: boolean;
  /** The person the account is, from its `person` link; it may no longer exist. */
  personPath?: string;
  /**
   * One of the two accounts made at boot, neither of which can be deleted: the administrator
   * (`admin`), who may do anything whatever its groups, and the guest whom a visitor browses as,
   * which has no password and whose groups give it nothing.
   */
  role?: UserRole;
};

export type UserRole = 'administrator' | 'guest';

/** `group-list`, `user-groups`: one group. */
export type GroupEntry = {
  groupname: string;
  gid: GroupId;
  title?: string;
  description?: string;
  /** One of the groups made at boot, none of which can be deleted. */
  role?: GroupRole;
  /**
   * `group-list --members`: the usernames linked into it, sorted; absent where the caller may not
   * list them. A user whose primary group it is belongs without a link and is not listed.
   */
  members?: string[];
};

/**
 * What a group made at boot is for:
 * - `administrators` (`admin`, gid 0) is the administrator's own group, as root's is on Linux:
 *   its members may read the system tree but write none of it, and are no administrators.
 * - `guests` (`guest`) is the guest account's own group.
 * - `everyone` (`users`) holds every account that signs in, linked or not.
 * - `ssh` may use `ssh`, `scp` and `ssh-copy-id` to reach other machines.
 * - `sudo` may make a sign-in of theirs an administrator's by entering their password again.
 */
export type GroupRole = 'administrators' | 'guests' | 'everyone' | 'ssh' | 'sudo';

/** `user-create`: the new account, and the groups it was linked into, its own first. */
export type UserCreated = {
  username: string;
  uid: UserId;
  gid: GroupId;
  path: string;
  /** The home, which the account owns. */
  home: string;
  groups: string[];
};

/** `group-create`: the new group. */
export type GroupCreated = { groupname: string; gid: GroupId; path: string };

/** `user-update`: the attrs it wrote. */
export type UserUpdated = { username: string; updated: { name?: string; email?: string; description?: string } };

/** `group-update`: the attrs it wrote. */
export type GroupUpdated = { groupname: string; updated: { title?: string; description?: string } };

/** `user-disable`, `user-enable`: whether the account is now refused sign-in. */
export type UserInactive = { username: string; inactive: boolean };

/** `user-elevate`: whether the sign-in is now an administrator's. */
export type UserElevated = { elevated: boolean };

/** `user-set-primary-group`: the account's primary group before and after. */
export type PrimaryGroupSet = { username: string; oldGid: GroupId; newGid: GroupId; primaryGroup: string };

/** `group-add-member`, `group-remove-member`: the membership link made or removed. */
export type MembershipChanged = { group: string; user: string; action: 'added' | 'removed' };

/**
 * Why a name cannot be a new user's or group's, or undefined when it can. `user-create` and
 * `group-create` refuse by it, and a form checks a name with it as it is typed.
 *
 * A name is a path segment under `/home` or `/etc/groups` and a word in a command line: lower-case
 * letters and digits in any script, and `.`, `_` and `-`, starting with a letter or `_`. Never with
 * a digit: commands read a word that looks like a number as a uid or gid. Never with `@`, which is
 * what tells an e-mail address apart at sign-in.
 */
export const accountNameProblem = (name: string): string | undefined => {
  if (name === '') return 'a name is required';
  if (name.length > 64) return 'a name is at most 64 characters';
  if (!/^[\p{L}_]/u.test(name)) return 'a name starts with a letter or _';
  if (!/^[\p{L}_][\p{L}\p{N}._-]*$/u.test(name)) return 'a name holds only letters, digits and . _ -';
  if (name !== name.toLowerCase()) return 'a name is lower case';
  return undefined;
};

/** An e-mail address as an account keeps it: trimmed and lower case, so two spellings are one address. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** Why `email` (as `normalizeEmail` leaves it) cannot be an account's address, or undefined when it can. */
export const emailProblem = (email: string): string | undefined => {
  if (email.length > 254) return 'an e-mail address is at most 254 characters';
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return 'an e-mail address is a name, @ and a domain';
  return undefined;
};

/** The letters and digits of `word`, lower case and without accents: `Björn` → `bjorn`. */
const nameWord = (word: string): string => word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * The usernames to offer a new account, best first, from the person's name and e-mail address:
 * the first name (`anna`), then with the capitals of the last name (`Anna Berg-Andersson` →
 * `annaba`), then the first name with a number (`anna2`, `anna3`, …). Without a name, the part of
 * the address before `@` stands in for it. Each candidate passes `accountNameProblem`.
 */
export function* usernameCandidates(name: string, email = ''): Generator<string> {
  const words = name.trim().split(/\s+/).filter((word) => nameWord(word) !== '');
  const first = words.length > 0 ? nameWord(words[0]) : nameWord(email.split('@')[0] ?? '');
  if (accountNameProblem(first)) return;
  yield first;
  if (words.length > 1) {
    const last = words[words.length - 1];
    const capitals = last.match(/\p{Lu}/gu) ?? [last[0]];
    const initials = nameWord(capitals.join(''));
    if (initials) yield `${first}${initials}`;
  }
  for (let n = 2;; n++) yield `${first}${n}`;
}

/**
 * The first of `usernameCandidates` that `taken` does not hold, or undefined when neither the name
 * nor the address gives one. A username is taken when an account or a group already has it: the
 * new account's own group is named like it.
 */
export const suggestUsername = (name: string, email: string, taken: (username: string) => boolean): string | undefined => {
  for (const candidate of usernameCandidates(name, email)) {
    if (!taken(candidate)) return candidate;
  }
  return undefined;
};

/** `user-resolve`: the account a uid or username names. */
export type UserResolved = { username: string; uid: UserId; title?: string };

/** `group-resolve`: the group a gid or group name names. */
export type GroupResolved = { groupname: string; gid: GroupId; title?: string };

/** `group-members`: one member; a link to an account since deleted carries its name only. */
export type GroupMember = {
  username: string;
  uid?: UserId;
  title?: string;
  /** The person the account is, from its `person` link, as for `user-list`. */
  personPath?: string;
};

/** `group-members --limit`: a first page of members, and how many there are. */
export type GroupMemberPage = { members: GroupMember[]; total: number };

/** `user-delete`: the account gone, and the account that took over what it owned. */
export type UserDeleted = {
  deleted: string;
  uid: UserId;
  /** The account that now owns what the deleted one owned. */
  to: string;
  /** Nodes it owned, now `to`'s. */
  owned: number;
  /** Nodes whose ACL named it; those entries are gone. */
  acl: number;
  /** Its own group: deleted with it, or kept because someone else still belongs to it. */
  group?: { groupname: string; deleted: boolean };
};

/** `group-delete`: the group gone, and the group that took over what it owned. */
export type GroupDeleted = {
  deleted: string;
  gid: GroupId;
  /** The group that now owns what the deleted one owned. */
  to: string;
  owned: number;
  acl: number;
};

/** `user-whoami`: the signed-in account, its user node's attrs, and what the session may do. */
export type Whoami = {
  id: string;
  username: string;
  uid: UserId;
  name?: string;
  description?: string;
  /** The person this account is, when it is linked to one. */
  personPath?: string;
  inactive?: boolean;
  mustResetPassword?: boolean;
  /** A property of this session's access, not a file mode bit. */
  admin: boolean;
  /** The groups this session's access carries, by gid, as of its sign-in: what access to a node or a module is judged by. */
  gids: GroupId[];
  /** Whether the sign-in is an administrator's because its account elevated it (`user-elevate`). */
  elevated: boolean;
  /** Whether the account may elevate the sign-in (`user-elevate`), being in the `sudo` group; elevated or not. */
  mayElevate: boolean;
  /** Whether the administrator opens the archive to the guest (`CFG_GUEST_BROWSING`); given to every caller. */
  guestBrowsing?: boolean;
  /** The share link this session opened last, while it still opens something: one at most; absent when none. */
  links?: HeldShareLink[];
  [attr: string]: unknown;
};

/** `label list`: one label, and how many nodes carry it. */
export type LabelEntry = { label: string; count: number };

/** `mod list`: one installed module. */
export type ModuleEntry = {
  name: string;
  version: string | null;
  description?: string;
  /** The range of the module API it is written against; absent when it declares none. */
  coreApi?: string;
  dependencies: Record<string, string>;
  path: string;
  /** Its `bin/` commands. */
  commands: string[];
  webUis: string[];
  /** The services it registers, by the name `service-list` gives them. */
  services: string[];
  /** The paths of its browser pages (`mod.json` `ui.routes`). */
  routes: string[];
  /** Its last `mod setup` in this process; absent when it has not been set up since EiN started. */
  setup?: ModuleSetup;
  /** Where `mod install` fetched it from; absent for a module the deployment provides. */
  installed?: ModuleInstall;
  /** The groups it is kept to (`mod groups`); absent when it is everyone's. */
  groups?: string[];
};

/** `mod groups <name>`: the groups a module is kept to, none when it is everyone's. */
export type ModuleGroups = { name: string; groups: string[] };

/** Where `mod install` fetched a module from, as it records it beside the module (`.install.json`). */
export type ModuleInstall = {
  /** The repository: `https://github.com/einhq/module-archive`. */
  repository: string;
  /** The branch, tag or commit it was asked for, or the default branch. */
  ref: string;
  /** The commit it is, in full. */
  commit: string;
  /** When, as an ISO time. */
  at: string;
};

/** `mod install`: what it installed or updated, dependencies first, and what it could not. */
export type ModuleInstallResult = {
  ok: boolean;
  installed: InstalledModule[];
  /** Why each argument it could not install failed, one line each. */
  failed: string[];
};

/** One module `mod install` put in place. */
export type InstalledModule = ModuleInstall & {
  name: string;
  version: string | null;
  /** Whether it replaced an installed one. */
  updated: boolean;
};

/** `mod search`: the published modules, the `module-*` repositories of each `CFG_MODULE_SOURCES` entry, and the sources that did not answer. */
export type ModuleSearch = {
  modules: PublishedModule[];
  failed: { source: string; reason: string }[];
};

/** One published module, as its repository has it on its default branch. */
export type PublishedModule = {
  /** The module's name: its repository's without `module-`. */
  name: string;
  /** What `mod install` takes: `https://github.com/einhq/module-archive`. */
  repository: string;
  /** The `CFG_MODULE_SOURCES` entry it was found in. */
  source: string;
  description: string;
  /** Its default branch. */
  branch: string;
  /** The default branch's commit, in full; absent when its refs could not be read. */
  commit?: string;
  /** Its `mod.json`'s; absent when it has none that can be read. */
  version?: string;
  coreApi?: string;
  /** Whether this core provides the module API its `coreApi` asks for; absent when it names none. */
  compatible?: boolean;
};

/** How a module's last `mod setup` went. */
export type ModuleSetup = {
  ok: boolean;
  /** Epoch ms. */
  at: number;
  /** Why it failed; empty when `ok`. */
  problems: string[];
};
