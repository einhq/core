import { join, resolve } from '@std/path';
import { ADMIN_ACCESS, ADMIN_GROUPNAME, USERS_GID } from '../access/constants.ts';
import type { Access } from '../access/types.ts';
import { isAdmin } from '../access/verify-access.ts';
import type { GroupId } from '../mode/types.ts';
import { GROUPS_PATH, USERS_PATH } from '../paths.ts';
import { NodeNotFoundError } from '../../vfs/errors.ts';
import type { NodeVFS } from '../../vfs/node-vfs.ts';
import type { Node } from '../../vfs/node.ts';
import type { NodeChildEntry } from '../../vfs/types.ts';
import { type GroupAttrs, isGroupNode } from '../../vfs/types/group.ts';
import { NODE_TYPE_SOFTLINK } from '../../vfs/types/softlink.ts';
import { isUserNode, type UserAttrs } from '../../vfs/types/user.ts';

/**
 * Whether `node`, linked as `name` in the group membership directory `membersPath`
 * (`<group>/users`), makes the account `name` a member: it is a softlink to that account's own
 * user node, `<USERS_PATH>/<name>`, as `group-add-member` makes it. Anything else there makes
 * nobody a member, whatever it is named.
 */
export const isMembership = (membersPath: string, name: string, node: Node): boolean =>
  node.type === NODE_TYPE_SOFTLINK && node.props.softlink !== undefined &&
  resolve(membersPath, node.props.softlink) === join(USERS_PATH, name);

/** The accounts a listing of the group membership directory `membersPath` makes members (`isMembership`). */
export const memberNames = (membersPath: string, listing: NodeChildEntry[]): string[] =>
  listing.filter((entry) => isMembership(membersPath, entry.name, entry.node)).map((entry) => entry.name);

/**
 * Whether the account `username`, whose user node is `userNode`, belongs to the group `groupname`
 * now, by the rule sign-in counts memberships by: it is the account's primary group, or the
 * group's membership directory makes it a member. A group `access` may not read is not one of its.
 */
export const isMemberOf = async (vfs: NodeVFS, access: Access, groupname: string, username: string, userNode: Node<UserAttrs>): Promise<boolean> => {
  const groupPath = join(GROUPS_PATH, groupname);
  try {
    const group = await vfs.get<GroupAttrs>(access, groupPath);
    if (!isGroupNode(group)) return false;
    if (userNode.attrs.gid === group.attrs.gid) return true;
    const membersPath = join(groupPath, 'users');
    return isMembership(membersPath, username, await vfs.get(access, join(membersPath, username), { readlink: true }));
  } catch {
    return false;
  }
};

/**
 * The gids of every group under `GROUPS_PATH` whose membership directory makes `username` a
 * member. Groups `access` may not list, and nodes there that are not groups, are skipped.
 */
const resolveMemberGids = async (vfs: NodeVFS, access: Access, username: string): Promise<GroupId[]> => {
  const gids: GroupId[] = [];

  let groups;
  try {
    groups = await vfs.children<GroupAttrs>(access, GROUPS_PATH);
  } catch {
    return gids;
  }

  for (const group of groups) {
    if (!isGroupNode(group.node)) continue;
    const membersPath = join(GROUPS_PATH, group.name, 'users');
    try {
      if (memberNames(membersPath, await vfs.children(access, membersPath)).includes(username)) {
        gids.push(group.node.attrs.gid);
      }
    } catch {
      // group has no users directory or is not accessible
    }
  }

  return gids;
};

/**
 * The access a signed-in session of `username` carries, whichever way it
 * signed in (the shell's `login`, SSH, SFTP). `userNode` is the account's own,
 * the user node at `<USERS_PATH>/<username>`.
 *
 * The primary group is the account's `gid` attr, which is what makes
 * `user set-primary-group` mean anything and what nodes created with an
 * explicit `gid: access.gid` get. `gids` holds it, `USERS_GID`, which every
 * signed-in person carries by design, and every group the user is linked into,
 * so group ownership and group ACL entries take effect — `verifyAccess`
 * consults `gids`, never `gid`. This is only as correct as the gid on the
 * account. See ein/core#270.
 */
export const userAccess = async (
  vfs: NodeVFS,
  access: Access,
  username: string,
  userNode: Node<UserAttrs>,
): Promise<Access> => {
  const memberGids = await resolveMemberGids(vfs, access, username);
  return {
    uid: userNode.attrs.uid,
    gid: userNode.attrs.gid,
    gids: [...new Set([USERS_GID, userNode.attrs.gid, ...memberGids])],
  };
};

/**
 * The access `username` would sign in with (`userAccess`), read from the account's user node at
 * `<USERS_PATH>/<username>` with `access`. For work done on someone's behalf — a service sorting
 * their inbox — that must see only what they could see.
 */
export const accessOfUser = async (vfs: NodeVFS, access: Access, username: string): Promise<Access> => {
  const userNode = await vfs.get(access, join(USERS_PATH, username));
  if (!isUserNode(userNode)) throw new Error(`not a user: ${username}`);
  return await userAccess(vfs, access, username, userNode);
};

/**
 * The gid of the group `name`, undefined when there is no such group. Looked up as the
 * administrator: a group's members need not be able to read `/etc/groups`.
 */
export const groupGid = async (vfs: NodeVFS, name: string): Promise<number | undefined> => {
  try {
    const node = await vfs.get(ADMIN_ACCESS, join(GROUPS_PATH, name));
    return isGroupNode(node) ? node.attrs.gid : undefined;
  } catch (error) {
    if (error instanceof NodeNotFoundError) return undefined;
    throw error;
  }
};

/** Whether `access` is in the group `gid`; an administrator is in `admin` whatever the gids say. */
const inGroup = (access: Access, name: string, gid: number): boolean => access.gids.includes(gid) || (name === ADMIN_GROUPNAME && isAdmin(access));

/**
 * The entries of `dir` named after a group `access` is in, by name: what a directory of per-group
 * files (`/etc/ui/groups`, `/etc/bashrc.d`) holds for whoever `access` is. `dir` is listed with
 * `access`. An entry naming no group is in `unknown`, for the caller to warn of.
 */
export const groupEntriesFor = async (vfs: NodeVFS, access: Access, dir: string): Promise<{ groups: string[]; unknown: string[] }> => {
  let names: string[];
  try {
    names = (await vfs.children(access, dir)).map((child) => child.name).sort();
  } catch (error) {
    if (error instanceof NodeNotFoundError) return { groups: [], unknown: [] };
    throw error;
  }
  const groups: string[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const gid = await groupGid(vfs, name);
    if (gid === undefined) unknown.push(name);
    else if (inGroup(access, name, gid)) groups.push(name);
  }
  return { groups, unknown };
};
