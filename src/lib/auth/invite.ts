/**
 * An account's sign-in link: a token in `<USERS_PATH>/<username>/.invite` that lets whoever holds
 * it choose the account's password, once, before it expires. An administrator makes one for an
 * account that has no password yet or whose person forgot it, and sends it however they like.
 */

import { join } from '@std/path';
import { ADMIN_ACCESS } from '../access/constants.ts';
import { USERS_PATH } from '../paths.ts';
import { isToken, newToken, sameToken } from '../token/mod.ts';
import { NodeNotFoundError } from '../../vfs/errors.ts';
import type { NodeVFS } from '../../vfs/node-vfs.ts';
import type { Node } from '../../vfs/node.ts';
import { isUserInviteNode, isUserNode, NODE_TYPE_USER_INVITE, type UserAttrs, type UserInviteAttrs } from '../../vfs/types/user.ts';
import type { UserId } from '../mode/types.ts';

const INVITE_FILE = '.invite';

/** How long a sign-in link works unless told otherwise. */
export const DEFAULT_INVITE_DAYS = 7;

/** The longest a sign-in link may work: it lets anyone who holds it become the account. */
export const MAX_INVITE_DAYS = 90;

/** The account's sign-in link while it still works, read as the administrator; undefined when it has none. */
export const readInvite = async (vfs: NodeVFS, userPath: string, now = Date.now()): Promise<Node<UserInviteAttrs> | undefined> => {
  try {
    const node = await vfs.get<UserInviteAttrs>(ADMIN_ACCESS, join(userPath, INVITE_FILE));
    return isUserInviteNode(node) && node.attrs.expiresAt > now ? node : undefined;
  } catch (error) {
    if (error instanceof NodeNotFoundError) return undefined;
    throw error;
  }
};

/** Take the account's sign-in link away, expired or not; one sent before stops working at once. */
export const removeInvite = async (vfs: NodeVFS, userPath: string): Promise<void> => {
  if (await vfs.exists(ADMIN_ACCESS, join(userPath, INVITE_FILE))) await vfs.unlink(ADMIN_ACCESS, join(userPath, INVITE_FILE), userPath);
};

/** Give the account a new sign-in link that works until `expiresAt`, in place of any before it, made by `by`. */
export const newInvite = async (vfs: NodeVFS, userPath: string, by: UserId, expiresAt: number): Promise<Node<UserInviteAttrs>> => {
  await removeInvite(vfs, userPath);
  const attrs: UserInviteAttrs = { token: newToken(), createdBy: by, createdAt: Date.now(), expiresAt };
  return await vfs.create<UserInviteAttrs>(ADMIN_ACCESS, NODE_TYPE_USER_INVITE, userPath, INVITE_FILE, {
    props: { mode: 0o600, tier: 'db' },
    attrs,
  });
};

/**
 * The account whose sign-in link `token` is, while it works; undefined for a token that names none,
 * whose link expired, or whose account is disabled. Each account's token is compared in full.
 */
export const accountByInvite = async (
  vfs: NodeVFS,
  token: string,
  now = Date.now(),
): Promise<{ username: string; userPath: string; userNode: Node<UserAttrs> } | undefined> => {
  if (!isToken(token)) return undefined;
  for (const entry of await vfs.children<UserAttrs>(ADMIN_ACCESS, USERS_PATH)) {
    if (!isUserNode(entry.node)) continue;
    const userPath = join(USERS_PATH, entry.name);
    const invite = await readInvite(vfs, userPath, now);
    if (!invite || !sameToken(invite.attrs.token, token)) continue;
    return entry.node.attrs.inactive === true ? undefined : { username: entry.name, userPath, userNode: entry.node };
  }
  return undefined;
};
