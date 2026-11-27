import type { Access } from '../access/types.ts';
import type { ModuleVFS } from '../../vfs/node-vfs.ts';
import { type GroupAttrs, isGroupNode } from '../../vfs/types/group.ts';
import { isUserNode, type UserAttrs } from '../../vfs/types/user.ts';

/**
 * The attr on a directory of principals — the accounts, the share links — holding the highest
 * number one of them has had. Nodes' birth, change and modification uids, the audit trail, the
 * access log and signed-in sessions keep naming a number after its holder is gone, so a number is
 * never given out twice: a new one goes past this mark as well as past every holder there is.
 */
const LAST_ID_ATTR = 'lastId';

/** The mark on the directory `dir` (`LAST_ID_ATTR`); undefined when it has none or is not there. */
export const lastIssuedId = async (vfs: ModuleVFS, access: Access, dir: string): Promise<number | undefined> => {
  const value = (await vfs.get(access, dir).catch(() => undefined))?.attrs[LAST_ID_ATTR];
  return typeof value === 'number' ? value : undefined;
};

/** Raise the mark on the directory `dir` to `id`, when it is lower. A directory that is not there keeps none. */
export const raiseLastIssuedId = async (vfs: ModuleVFS, access: Access, dir: string, id: number): Promise<void> => {
  if (!(await vfs.exists(access, dir))) return;
  const last = await lastIssuedId(vfs, access, dir);
  if (last !== undefined && last >= id) return;
  await vfs.update(access, dir, { attrs: { [LAST_ID_ATTR]: id } });
};

/**
 * The first number past every uid and gid an account or group has had, from 1000 up: past the
 * mark on the accounts directory `usersPath`, every account's uid there and every group's gid in
 * `groupsPath`. Uids and gids are one count, since an account's own group takes its uid as gid
 * and a session counts its gids as memberships.
 */
export const nextAccountId = async (vfs: ModuleVFS, access: Access, usersPath: string, groupsPath: string): Promise<number> => {
  const users = (await vfs.children<UserAttrs>(access, usersPath).catch(() => [])).filter((entry) => isUserNode(entry.node));
  const groups = (await vfs.children<GroupAttrs>(access, groupsPath).catch(() => [])).filter((entry) => isGroupNode(entry.node));
  return Math.max(
    999,
    (await lastIssuedId(vfs, access, usersPath)) ?? 0,
    ...users.map((entry) => entry.node.attrs.uid),
    ...groups.map((entry) => entry.node.attrs.gid),
  ) + 1;
};
