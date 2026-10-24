/**
 * An account's password: the scrypt hash in `<USERS_PATH>/<username>/.password`, and signing in
 * with it. Everything that sets, checks or asks after an account's password does it here, so the
 * shell's `login` and `user-elevate`, the SSH server and `user-passwd` follow one rule.
 */

import { join } from '@std/path';
import { toText } from '@std/streams/to-text';
import { type Access, ADMIN_ACCESS, ADMIN_GID, ADMIN_UID } from '../access/mod.ts';
import type { NodeVFS } from '../../vfs/node-vfs.ts';
import type { Node } from '../../vfs/node.ts';
import { type FileAttrs, NODE_TYPE_FILE } from '../../vfs/types/file.ts';
import { loginRefusal, type UserAttrs } from '../../vfs/types/user.ts';
import { accountByLoginName } from './email.ts';
import { hashPassword, passwordHashLogN, verifyPassword } from './password.ts';
import { type SignInThrottle, signInThrottle } from './sign-in-throttle.ts';

const PASSWORD_FILE = '.password';

/** What a wrong password, an unknown account and an account without a password all fail with. */
export const AUTHENTICATION_FAILED = 'authentication failed';

/** Whether the account at `userPath` has a password set. Read as the administrator, who alone may. */
export const hasAccountPassword = (vfs: NodeVFS, userPath: string): Promise<boolean> => vfs.exists(ADMIN_ACCESS, join(userPath, PASSWORD_FILE));

/** The hash in the account's `.password`, or undefined when it has none. Read as the administrator, who alone may. */
async function storedPasswordHash(vfs: NodeVFS, userPath: string): Promise<string | undefined> {
  try {
    const handle = await vfs.open(ADMIN_ACCESS, join(userPath, PASSWORD_FILE), { mode: 'r' });
    try {
      return await toText(handle.readable);
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** Whether `password` is the one set for the account at `userPath`; false when it has none. */
export async function isAccountPassword(vfs: NodeVFS, userPath: string, password: string): Promise<boolean> {
  const passwordHash = await storedPasswordHash(vfs, userPath);
  return passwordHash !== undefined && await verifyPassword(password, passwordHash);
}

const dummyHashes = new Map<number, Promise<string>>();

/**
 * A hash of no one's password at the cost `env` sets, made once per cost: what a sign-in verifies
 * against when there is no account or it has no password, so that it costs what a wrong password
 * does.
 */
function dummyPasswordHash(env: Record<string, string | undefined>): Promise<string> {
  const logN = passwordHashLogN(env);
  let hash = dummyHashes.get(logN);
  if (!hash) {
    hash = hashPassword(crypto.randomUUID(), env);
    dummyHashes.set(logN, hash);
  }
  return hash;
}

/**
 * Make `password` the account's, writing as `access`, which must be allowed to: the file is the
 * administrator's, as the account is, so its user may neither read nor replace it. `env` carries
 * the hash cost (`passwordHashLogN`): the process's environment, such as a tty's `launchEnv`, never
 * a shell's own, which whoever is at it can change.
 */
export async function setAccountPassword(
  vfs: NodeVFS,
  access: Access,
  userPath: string,
  password: string,
  env: Record<string, string | undefined>,
): Promise<void> {
  const encoded = new TextEncoder().encode(await hashPassword(password, env));
  const passwordPath = join(userPath, PASSWORD_FILE);
  if (!await vfs.exists(ADMIN_ACCESS, passwordPath)) {
    const attrs: FileAttrs = { name: PASSWORD_FILE, mimetype: 'text/plain', size: encoded.length };
    await vfs.create(access, NODE_TYPE_FILE, userPath, PASSWORD_FILE, {
      props: { uid: ADMIN_UID, gid: ADMIN_GID, mode: 0o600, tier: 'db' },
      attrs,
    });
  }
  const handle = await vfs.open(access, passwordPath, { mode: 'w' });
  try {
    await handle.write(encoded);
  } finally {
    await handle.close();
  }
}

/** The account a sign-in names, as `accountByLoginName` finds it. */
export type SignInAccount = { username: string; userPath: string; userNode: Node<UserAttrs> };

/** Where a sign-in comes from: the process's environment, for the hash cost, and the client's address when known. */
type SignInOrigin = { env: Record<string, string | undefined>; from?: string; throttle?: SignInThrottle };

/**
 * Sign in by password: the account `typed` names, by username or e-mail address, when `password`
 * is its own and it may sign in at all (`loginRefusal`). Every attempt goes through the throttle,
 * costs one hash and fails no sooner than the throttle answers a failure, so neither the answer nor
 * its time says whether the account exists: an unknown account, a wrong password and no password
 * set all throw `AUTHENTICATION_FAILED`, and only the right password learns why an account may not
 * sign in.
 */
export async function passwordSignIn(vfs: NodeVFS, typed: string, password: string, origin: SignInOrigin): Promise<SignInAccount> {
  const account = await accountByLoginName(vfs, typed);
  const attempt = await (origin.throttle ?? signInThrottle).begin(account?.username ?? typed.trim().toLowerCase(), origin.from);
  const passwordHash = account && await storedPasswordHash(vfs, account.userPath);
  const right = await verifyPassword(password, passwordHash ?? await dummyPasswordHash(origin.env));
  if (!account || passwordHash === undefined || !right) {
    await attempt.failed();
    throw new Error(AUTHENTICATION_FAILED);
  }
  attempt.succeeded();
  const refusal = loginRefusal(account.userNode.attrs);
  if (refusal) throw new Error(refusal);
  return account;
}
