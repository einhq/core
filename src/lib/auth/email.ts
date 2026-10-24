/**
 * An account's e-mail address: how a command takes one, which account holds one, and which
 * account a name typed at sign-in is — its username, or an address one account holds.
 */

import { join } from '@std/path';
import { ADMIN_ACCESS } from '../access/constants.ts';
import { emailProblem, normalizeEmail } from '../api/users.ts';
import { USERS_PATH } from '../paths.ts';
import type { NodeVFS } from '../../vfs/node-vfs.ts';
import type { Node } from '../../vfs/node.ts';
import { isUserNode, type UserAttrs } from '../../vfs/types/user.ts';

/** An `--email` flag's value as the account keeps it, `''` to have none, or why it cannot be one. */
export const parseEmailFlag = (value: string): { email: string } | { problem: string } => {
  const email = normalizeEmail(value);
  if (email === '') return { email };
  const problem = emailProblem(email);
  return problem ? { problem } : { email };
};

/**
 * The usernames of the accounts under `usersPath` whose address is `email` (as `normalizeEmail`
 * leaves it), other than `except`. Read as the administrator: an address is taken whether or not
 * the caller may see who has it.
 */
const emailHolders = async (vfs: NodeVFS, usersPath: string, email: string, except?: string): Promise<string[]> => {
  const children = await vfs.children<UserAttrs>(ADMIN_ACCESS, usersPath);
  return children.filter((entry) => entry.name !== except && isUserNode(entry.node) && entry.node.attrs.email === email).map((entry) => entry.name);
};

/** The account other than `except` that already has the address `email`, if any (see `emailHolders`). */
export const emailHolder = async (vfs: NodeVFS, usersPath: string, email: string, except?: string): Promise<string | undefined> =>
  (await emailHolders(vfs, usersPath, email, except))[0];

/**
 * The account a name typed at sign-in is: with an `@`, the one account whose address it is, in any
 * case — none when two hold it, which the account commands never let happen; otherwise the user node at `<USERS_PATH>/<name>`, lower-cased, since usernames are. Undefined
 * when there is none. Whether it may sign in is the caller's to ask (`loginRefusal`).
 */
export const accountByLoginName = async (
  vfs: NodeVFS,
  typed: string,
): Promise<{ username: string; userPath: string; userNode: Node<UserAttrs> } | undefined> => {
  let username = typed.trim().toLowerCase();
  if (username.includes('@')) {
    const holders = await emailHolders(vfs, USERS_PATH, normalizeEmail(typed));
    if (holders.length !== 1) return undefined;
    username = holders[0];
  }
  if (!username) return undefined;
  const userPath = join(USERS_PATH, username);
  const userNode = await vfs.get<UserAttrs>(ADMIN_ACCESS, userPath).catch(() => undefined);
  if (!userNode || !isUserNode(userNode)) return undefined;
  return { username, userPath, userNode };
};
