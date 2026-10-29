/**
 * The sharing dialog's vocabulary: access levels read from and written to mode bits, the edits the
 * dialog makes to a draft, and the commands a draft becomes. The server is the authority —
 * `share-info` reports what it read and `share-set` decides what is written; this only has to be
 * right enough to draw the dialog and build the command it sends.
 */

import { shq as quote } from './shquote.ts';
import type { NodeOwnership, ShareGrant, ShareInfo, ShareLevel } from '@ein/api';
export type { ShareGrant, ShareLevel } from '@ein/api';

const READ = 4;
const WRITE = 2;
const EXEC = 1;

/** The group every account belongs to (`USERS_GID` in core): everyone signed in. */
const USERS_GID = 1002;

/** The guest's group (`GUEST_GID` in core): a grant to it is a grant to visitors who are not signed in. */
const GUEST_GID = 1001;

/** Where share links' principals' uids start (`LINK_UID_BASE` in core): an entry naming one is a link's. */
const LINK_UID_BASE = 0x40000000;

const isLinkEntry = (entry: { uid?: number }): boolean => entry.uid !== undefined && entry.uid >= LINK_UID_BASE;

/** Whether a grant is the one to visitors, which the dialog shows as its own row. */
const isVisitorsGrant = (grant: Pick<ShareGrant, 'kind' | 'id'>): boolean => grant.kind === 'group' && grant.id === GUEST_GID;

/** Bit shifts for the group and everyone classes of the mode. */
const GROUP = 3;
const OTHER = 0;

/** The `rwx` string `share-set` takes for an ACL entry. */
const levelToPerms = (level: ShareLevel): string => (level === 'edit' ? 'rwx' : level === 'view' ? 'rx' : '');

const levelFromBits = (bits: number): ShareLevel => (bits & WRITE ? 'edit' : bits & READ ? 'view' : 'none');

const bitsFromLevel = (level: ShareLevel): number => {
  // Execute rides along with read: a directory granted read alone cannot be
  // traversed, so the grant would do nothing.
  if (level === 'edit') return READ | WRITE | EXEC;
  if (level === 'view') return READ | EXEC;
  return 0;
};

export const levelAt = (mode: number, shift: number): ShareLevel => levelFromBits((mode >> shift) & 7);

/** Replace one class's bits, leaving the other two alone. */
export const withLevelAt = (mode: number, shift: number, level: ShareLevel): number => (mode & ~(7 << shift)) | (bitsFromLevel(level) << shift);

export const groupLevel = (mode: number): ShareLevel => levelAt(mode, GROUP);
export const everyoneLevel = (mode: number): ShareLevel => levelAt(mode, OTHER);

export const withGroupLevel = (mode: number, level: ShareLevel): number => withLevelAt(mode, GROUP, level);
export const withEveryoneLevel = (mode: number, level: ShareLevel): number => withLevelAt(mode, OTHER, level);

/** What the dialog holds while it is open, before Save turns it into a command. */
export type ShareDraft = {
  mode: number;
  grants: ShareGrant[];
};

/**
 * A grant's identity in a draft: whom it names and where it is written. The node's own group is in
 * the mode bits and every other grant in the access list, and the same group can be in both.
 */
export const grantKey = (grant: Pick<ShareGrant, 'kind' | 'source' | 'id'>): string => `${grant.kind}:${grant.source}:${grant.id}`;

/** The grants that give a person or group anything, as the dialog lists them; visitors have a row of their own. */
export const listedGrants = (draft: ShareDraft): ShareGrant[] => draft.grants.filter((grant) => grant.level !== 'none' && !isVisitorsGrant(grant));

/** Change one grant's level. */
export const withGrantLevel = (draft: ShareDraft, key: string, level: ShareLevel): ShareDraft => ({
  ...draft,
  grants: draft.grants.map((grant) => (grantKey(grant) === key ? { ...grant, level } : grant)),
});

/**
 * Take a grant away. The node's own group stays in the draft with no access — its bits are what is
 * written, so dropping it would leave them as they were — while an access-list entry goes.
 */
export const withoutGrant = (draft: ShareDraft, key: string): ShareDraft => ({
  ...draft,
  grants: draft.grants.flatMap((grant) => (grantKey(grant) !== key ? [grant] : grant.source === 'primary' ? [{ ...grant, level: 'none' as const }] : [])),
});

/**
 * Give someone access: the node's own group through its bits, when that is the group added, and
 * anyone else through an access-list entry, replacing one they have.
 */
export const withGrant = (draft: ShareDraft, grant: Omit<ShareGrant, 'source'>): ShareDraft => {
  const primary = draft.grants.find((each) => each.source === 'primary');
  if (grant.kind === 'group' && primary?.id === grant.id) return withGrantLevel(draft, grantKey(primary), grant.level);

  const entry: ShareGrant = { ...grant, source: 'acl' };
  const key = grantKey(entry);
  return draft.grants.some((each) => grantKey(each) === key)
    ? { ...draft, grants: draft.grants.map((each) => (grantKey(each) === key ? entry : each)) }
    : { ...draft, grants: [...draft.grants, entry] };
};

const LEVEL_ORDER: ShareLevel[] = ['none', 'view', 'edit'];

const higher = (a: ShareLevel, b: ShareLevel): ShareLevel => (LEVEL_ORDER.indexOf(a) >= LEVEL_ORDER.indexOf(b) ? a : b);

/**
 * The draft a dialog opens on: what is stored, with whatever the other bits give shown as the
 * Users group's grant. The other bits are the system's, and on content they reach the accounts,
 * which the Users group does too; a save writes it there and leaves the other bits empty.
 */
export const openingDraft = (info: Pick<ShareInfo, 'mode' | 'grants' | 'groups'>): ShareDraft => {
  const stored = { mode: info.mode, grants: info.grants };
  const others = everyoneLevel(info.mode);
  if (others === 'none') return stored;

  const cleared = { ...stored, mode: withEveryoneLevel(info.mode, 'none') };
  const held = info.grants.find((grant) => grant.kind === 'group' && grant.id === USERS_GID && grant.level !== 'none');
  if (held) return withGrantLevel(cleared, grantKey(held), higher(held.level, others));

  const users = info.groups.find((group) => group.gid === USERS_GID);
  return withGrant(cleared, {
    kind: 'group',
    id: USERS_GID,
    name: users?.groupname ?? String(USERS_GID),
    ...(users?.title ? { title: users.title } : {}),
    ...(users ? { members: users.members } : {}),
    role: 'everyone',
    level: others,
  });
};

/** Whether visitors who are not signed in may see it: a grant to the guest's group. */
export const visitorsSee = (draft: ShareDraft): boolean => draft.grants.some((grant) => isVisitorsGrant(grant) && grant.level !== 'none');

/** Let visitors see it, or take that away. Never write: the guest writes nothing. */
export const withVisitors = (draft: ShareDraft, sees: boolean, groupname = 'guest'): ShareDraft => {
  const others = draft.grants.filter((grant) => !isVisitorsGrant(grant));
  if (!sees) return { ...draft, grants: others };
  return { ...draft, grants: [...others, { kind: 'group', id: GUEST_GID, name: groupname, role: 'guests', level: 'view', source: 'acl' }] };
};

/** `0750` — what `share-set --mode` takes. */
const octal = (mode: number): string => (mode & 0o7777).toString(8).padStart(4, '0');

/** Nobody but the owner: no group, person, or visitor reads it. Its links are not in the draft. */
export const privateDraft = (draft: ShareDraft): ShareDraft => ({
  mode: withEveryoneLevel(draft.mode, 'none'),
  grants: draft.grants.flatMap((grant) => (grant.source === 'primary' ? [{ ...grant, level: 'none' as const }] : [])),
});

/** The group every account belongs to, as the dialog lists groups. */
type UsersGroup = Pick<ShareInfo['groups'][number], 'gid' | 'groupname' | 'title' | 'members' | 'role'>;

/** Everyone with an account reads it, through the Users group, and nobody is granted more. */
export const defaultDraft = (draft: ShareDraft, users: UsersGroup): ShareDraft =>
  withGrant(privateDraft(draft), {
    kind: 'group',
    id: users.gid,
    name: users.groupname,
    ...(users.title ? { title: users.title } : {}),
    members: users.members,
    ...(users.role ? { role: users.role } : {}),
    level: 'view',
  });

/** What a draft is saved with besides itself. */
export type ShareSaveOptions = {
  /** Hold the nodes against changes made further up: they keep their own sharing. */
  pin?: boolean;
  /** Take the share links' entries off too, so no link opens them. */
  dropLinks?: boolean;
};

/**
 * The single `share-set` a saved draft becomes.
 *
 * One command, not one per changed row: each recursive pass walks the whole
 * subtree, so a three-row change on a large album would otherwise cost four
 * descents to express one intent. `-b` plus the full `-m` set replaces each
 * node's user and group entries outright, which is also what makes a removed
 * row disappear rather than linger; its share links stay.
 *
 * The primary group is folded back into the mode bits here. It is the one grant
 * that is not an access-list entry, and the dialog should not have to remember
 * that while the user is clicking.
 */
export const buildShareCommand = (paths: string | readonly string[], draft: ShareDraft, opts: ShareSaveOptions = {}): string => {
  const primary = draft.grants.find((grant) => grant.source === 'primary');
  const mode = withGroupLevel(draft.mode, primary?.level ?? 'none');

  const parts = ['share-set', ...(typeof paths === 'string' ? [paths] : paths).map(quote), '--mode', octal(mode), '-b'];
  if (opts.dropLinks) parts.push('--drop-links');
  if (opts.pin) parts.push('--pin');

  for (const grant of draft.grants) {
    if (grant.source === 'primary' || grant.level === 'none') continue;
    parts.push('-m', quote(`${grant.kind === 'group' ? 'g' : 'u'}:${grant.name}:${levelToPerms(grant.level)}`));
  }

  return parts.join(' ');
};

/** Share nodes as `reference` is — its group, bits and access list, its links among them — and let changes from above reach them again. */
export const buildReferenceCommand = (paths: readonly string[], reference: string): string =>
  ['share-set', ...paths.map(quote), '--reference', quote(reference), '--unpin'].join(' ');

/** Share every node below `reference` that keeps its own sharing as `reference` is, and let its changes reach them again. */
export const buildFollowAllCommand = (reference: string): string => ['share-set', quote(reference), '--pinned-below', '--reference', quote(reference), '--unpin'].join(' ');

/**
 * How visible a node is, in the one word a header says it in: `public` when a link opens it or
 * visitors who have not signed in see it, `restricted` when not every account does, `private` when
 * nobody but its owner does. `null` is the default — every account sees it — which needs no word.
 */
export type Visibility = 'public' | 'restricted' | 'private' | null;

/** Who reads a node, as far as its visibility asks. */
type Readers = {
  /** A share link opens it. */
  link: boolean;
  /** The guest's group is granted it: visitors see it, where they may browse. */
  visitors: boolean;
  /** Every account reads it: the Users group, or the other bits, which on content reach no one else. */
  users: boolean;
  /** Any group or person reads it besides the owner. */
  anyone: boolean;
};

const visibility = ({ link, visitors, users, anyone }: Readers, guestBrowsing: boolean): Visibility => {
  if (link || (visitors && guestBrowsing)) return 'public';
  if (users) return null;
  return anyone ? 'restricted' : 'private';
};

/** A node's visibility, read off its ownership as a listing carries it. */
export const ownershipVisibility = (ownership: NodeOwnership, guestBrowsing: boolean): Visibility => {
  const acl = ownership.acl ?? [];
  const reads = acl.filter((entry) => !isLinkEntry(entry) && (entry.mode & READ) !== 0);
  const groupReads = groupLevel(ownership.mode) !== 'none';
  return visibility({
    link: acl.some(isLinkEntry),
    visitors: reads.some((entry) => entry.gid === GUEST_GID),
    users: everyoneLevel(ownership.mode) !== 'none' || (groupReads && ownership.gid === USERS_GID) || reads.some((entry) => entry.gid === USERS_GID),
    anyone: groupReads || reads.length > 0,
  }, guestBrowsing);
};

/** A draft's visibility, as it would be saved, with the links the node has. */
export const draftVisibility = (draft: ShareDraft, link: boolean, guestBrowsing: boolean): Visibility => {
  const grants = listedGrants(draft);
  return visibility({
    link,
    visitors: visitorsSee(draft),
    users: everyoneLevel(draft.mode) !== 'none' || grants.some((grant) => grant.kind === 'group' && grant.id === USERS_GID),
    anyone: grants.length > 0,
  }, guestBrowsing);
};
