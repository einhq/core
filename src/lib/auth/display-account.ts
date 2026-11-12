/**
 * The accounts a share link may show things as (`share-link create --as`): whoever holds such a
 * link reads what the account reads, without signing in, so it is kept to accounts that are meant
 * for showing things — active, neither the administrator nor the guest, and in no group that makes
 * an administrator, may become one, or reaches other machines.
 */

import { ADMIN_ACCESS, ADMIN_GROUPNAME, ADMIN_UID, GUEST_UID, SSH_GROUPNAME, SUDO_GROUPNAME } from '../access/constants.ts';
import type { Access } from '../access/types.ts';
import { USERS_PATH } from '../paths.ts';
import type { ModuleVFS } from '../../vfs/node-vfs.ts';
import type { Node } from '../../vfs/node.ts';
import { isUserNode, type UserAttrs } from '../../vfs/types/user.ts';
import { isMemberOf, userAccess } from './member-gids.ts';

/** The groups whose members no link shows things as. */
export const PRIVILEGED_GROUPS = [ADMIN_GROUPNAME, SUDO_GROUPNAME, SSH_GROUPNAME] as const;

/** An account by its name and user node. */
export type Account = { username: string; node: Node<UserAttrs> };

/** The account named `username`, read as the administrator; undefined when there is none. */
export const accountNamed = async (vfs: ModuleVFS, username: string): Promise<Account | undefined> => {
  if (!/^[^/]+$/.test(username)) return undefined;
  const node = await vfs.get<UserAttrs>(ADMIN_ACCESS, `${USERS_PATH}/${username}`).catch(() => undefined);
  return node && isUserNode(node) ? { username, node } : undefined;
};

/** The account with `uid`, read as the administrator; undefined when there is none. */
export const accountOfUid = async (vfs: ModuleVFS, uid: number): Promise<Account | undefined> => {
  const users = await vfs.children<UserAttrs>(ADMIN_ACCESS, USERS_PATH).catch(() => []);
  const entry = users.find((candidate) => isUserNode(candidate.node) && candidate.node.attrs.uid === uid);
  return entry && isUserNode(entry.node) ? { username: entry.name, node: entry.node } : undefined;
};

/** Why no link may show things as `account`, or undefined when one may. */
export const displayRefusal = async (vfs: ModuleVFS, account: Account): Promise<string | undefined> => {
  const { username, node } = account;
  if (node.attrs.uid === ADMIN_UID) return 'a link never shows things as the administrator';
  if (node.attrs.uid === GUEST_UID) return 'a link shows things as an account, and the guest is none';
  if (node.attrs.inactive === true) return `${username} is disabled`;
  for (const group of PRIVILEGED_GROUPS) {
    if (await isMemberOf(vfs, ADMIN_ACCESS, group, username, node)) return `${username} is in the ${group} group, whose members a link never shows things as`;
  }
  return undefined;
};

/**
 * The access a link that shows things as the account `uid` reads with: the account's own, as it
 * would sign in with. Undefined when the account is gone or a link may no longer show things as it.
 */
export const displayAccess = async (vfs: ModuleVFS, uid: number): Promise<Access | undefined> => {
  const account = await accountOfUid(vfs, uid);
  if (!account || await displayRefusal(vfs, account)) return undefined;
  return await userAccess(vfs, ADMIN_ACCESS, account.username, account.node);
};
