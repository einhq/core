import { join } from '@std/path';
import { ADMIN_ACCESS, ADMIN_UID, USERS_GID, verifyAccess } from '../../../../../lib/access/mod.ts';
import { memberNames } from '../../../../../lib/auth/member-gids.ts';
import type { Access, AccessLevel } from '../../../../../lib/access/mod.ts';
import { MaskACL, MaskGroup, MaskOther, MaskOwner } from '../../../../../lib/mode/mod.ts';
import type { GroupId, Ownership, ShareLevel, UserId } from '../../../../../lib/mode/mod.ts';
import { checkMode } from '../../../../../lib/mode/mod.ts';
import type { NodeChildEntry, NodeVFS } from '../../../../../vfs/mod.ts';
import { type GroupAttrs, isGroupNode } from '../../../../../vfs/types/group.ts';
import { isUserNode, type UserAttrs } from '../../../../../vfs/types/user.ts';
import type { EffectiveEntry } from '../../../../../lib/api/share.ts';

type GroupSummary = {
  groupname: string;
  gid: GroupId;
  title?: string;
  description?: string;
  /** Members, so a row can say how many people a grant reaches. */
  members: string[];
};

type UserSummary = {
  /** Absolute path of the user node, used to resolve its cover photo. */
  path: string;
  /** The person the account is, from its `person` link, whose picture stands for it; it may no longer exist. */
  personPath?: string;
  username: string;
  uid: UserId;
  title?: string;
  inactive: boolean;
  /** The user node's own group — what a session takes as its primary gid. */
  gid: GroupId;
  /** Every gid this user's session would carry, in the order login builds them. */
  gids: GroupId[];
};

/** The whole user/group graph, read in one pass. */
type Directory = {
  groups: GroupSummary[];
  users: UserSummary[];
};

/**
 * Read every group, its membership, and every user — in G+1 listings. A group's
 * members are the accounts its membership links make members (`memberNames`),
 * by the rule sign-in counts them by.
 *
 * The per-user counterpart, `userAccess`, costs one full scan of the
 * groups per user, which is what login pays for a single person and what a
 * sharing preview over the whole user list must not.
 *
 * `gids` is assembled the way `Shell.login` assembles it: `USERS_GID`, which
 * every signed-in person carries, then the user node's own primary group, then
 * the memberships. That is not a nicety — a preview built from anything else
 * would disagree with what the server goes on to enforce, and agreeing with it
 * is the only reason the preview is worth showing.
 */
export const readDirectory = async (
  vfs: NodeVFS,
  access: Access,
  groupsPath: string,
  usersPath: string,
): Promise<Directory> => {
  let groupEntries: NodeChildEntry<GroupAttrs>[];
  try {
    groupEntries = (await vfs.children<GroupAttrs>(access, groupsPath)).filter((entry) => isGroupNode(entry.node));
  } catch {
    groupEntries = [];
  }

  const groups: GroupSummary[] = await Promise.all(groupEntries.map(async (entry) => {
    let members: string[] = [];
    const membersPath = join(groupsPath, entry.name, 'users');
    try {
      members = memberNames(membersPath, await vfs.children(access, membersPath));
    } catch {
      // No membership directory, or not readable from here.
    }

    return {
      groupname: entry.name,
      gid: entry.node.attrs.gid,
      title: entry.node.attrs.title,
      description: entry.node.attrs.description,
      members,
    };
  }));

  let userEntries: NodeChildEntry<UserAttrs>[];
  try {
    userEntries = (await vfs.children<UserAttrs>(access, usersPath)).filter((entry) => isUserNode(entry.node));
  } catch {
    userEntries = [];
  }

  // Read as the administrator: the link is the account's, and where it points opens nothing — the
  // picture is still read with the caller's own access.
  const personPaths = await Promise.all(
    userEntries.map((entry) =>
      vfs.get(ADMIN_ACCESS, join(usersPath, entry.name, 'person'), { follow: false }).then((link) => link.props.softlink || undefined, () => undefined)
    ),
  );

  const users: UserSummary[] = userEntries.map((entry, i) => ({
    path: join(usersPath, entry.name),
    ...(personPaths[i] ? { personPath: personPaths[i] } : {}),
    username: entry.name,
    uid: entry.node.attrs.uid,
    title: entry.node.attrs.name,
    inactive: entry.node.attrs.inactive === true,
    gid: entry.node.props.gid,
    gids: [
      ...new Set([
        USERS_GID,
        entry.node.props.gid,
        ...groups.filter((group) => group.members.includes(entry.name)).map((group) => group.gid),
      ]),
    ],
  }));

  return { groups, users };
};

/**
 * The access one user's session would be granted, and the rule that grants it.
 *
 * `groupGid` is returned rather than a name so the caller can label the row; a
 * grant through an access-list entry names *that* group, not whichever one the
 * node happens to belong to.
 */
const effectiveFor = (
  user: UserSummary,
  ownership: Ownership,
): (EffectiveEntry & { groupGid?: GroupId }) | null => {
  const access: Access = { uid: user.uid, gid: user.gid, gids: user.gids };

  if (!verifyAccess(access, ownership, 'r')) {
    return null;
  }

  const level: ShareLevel = verifyAccess(access, ownership, 'w') ? 'edit' : 'view';
  const base = { path: user.path, username: user.username, title: user.title, level };

  // Explain the level being shown, not merely the read that got the user onto
  // the list: someone who reads through the node's group but writes through an
  // access-list entry is listed as "Can edit", and naming the reading group
  // would be the wrong reason for it.
  const probe: AccessLevel = level === 'edit' ? 'w' : 'r';

  // Otherwise the same order `verifyAccess` checks in, so the reason shown is
  // the rule that actually applied.
  if (user.uid === ADMIN_UID) {
    return { ...base, via: 'admin' };
  }

  if (ownership.uid === user.uid && checkMode(ownership.mode, probe, MaskOwner)) {
    return { ...base, via: 'owner' };
  }

  if (user.gids.includes(ownership.gid) && checkMode(ownership.mode, probe, MaskGroup)) {
    return { ...base, via: 'group', groupGid: ownership.gid };
  }

  if (checkMode(ownership.mode, probe, MaskOther)) {
    return { ...base, via: 'everyone' };
  }

  const entries = ownership.acl ?? [];

  if (entries.some((ac) => ac.uid !== undefined && ac.uid === user.uid && checkMode(ac.mode, probe, MaskACL))) {
    return { ...base, via: 'direct' };
  }

  const viaEntry = entries.find((ac) => ac.gid !== undefined && user.gids.includes(ac.gid) && checkMode(ac.mode, probe, MaskACL));
  if (viaEntry) {
    return { ...base, via: 'group', groupGid: viaEntry.gid };
  }

  // Unreachable while this mirrors `verifyAccess`: one of the rules above must
  // have granted `probe`, or the level would not have been read off it.
  return { ...base, via: 'group' };
};

/**
 * Everyone who can reach the node, most access first.
 *
 * Built by running the real `verifyAccess` over each user's session identity
 * rather than by re-deriving the rules here, so the list cannot drift from what
 * the server enforces — which is the only thing that makes it worth showing.
 */
export const effectiveAccess = (users: UserSummary[], ownership: Ownership, groups: GroupSummary[]): EffectiveEntry[] => {
  const order: Record<EffectiveEntry['via'], number> = { admin: 0, owner: 1, direct: 2, group: 3, everyone: 4 };
  const groupName = new Map(groups.map((group) => [group.gid, group.groupname]));

  return users
    .map((user) => {
      const entry = effectiveFor(user, ownership);
      if (!entry) return null;

      const { groupGid, ...rest } = entry;
      return groupGid === undefined ? rest : { ...rest, viaGroup: groupName.get(groupGid) ?? String(groupGid) };
    })
    .filter((entry): entry is EffectiveEntry => entry !== null)
    .sort((a, b) =>
      (a.level === b.level ? 0 : a.level === 'edit' ? -1 : 1) ||
      order[a.via] - order[b.via] ||
      a.username.localeCompare(b.username)
    );
};
