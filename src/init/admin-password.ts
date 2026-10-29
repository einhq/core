/**
 * The administrator's first password, set once a new instance has booted and the account has none.
 *
 * It is set here rather than by the init scripts so that the deployment's password never reaches
 * a shell: the boot shell's environment is what every service starts with.
 */

import { join } from '@std/path';
import { ADMIN_ACCESS, ADMIN_USERNAME } from '../lib/access/mod.ts';
import { hasAccountPassword, setAccountPassword } from '../lib/auth/account-password.ts';
import { USERS_PATH } from '../lib/paths.ts';
import type { NodeVFS } from '../vfs/node-vfs.ts';

/** What `setFirstAdminPassword` did: nothing, the deployment's password, or a random one to show. */
type FirstAdminPassword = { set: 'none' } | { set: 'given' } | { set: 'random'; password: string };

/**
 * Give the administrator `INITIAL_ADMIN_PASSWORD` from `env`, or a random password when it is
 * empty, unless the account has a password already. `env` also carries the hash cost
 * (`CFG_PASSWORD_HASH_LOGN`).
 */
export async function setFirstAdminPassword(vfs: NodeVFS, env: Record<string, string | undefined>): Promise<FirstAdminPassword> {
  const userPath = join(USERS_PATH, ADMIN_USERNAME);
  if (await hasAccountPassword(vfs, userPath)) return { set: 'none' };
  const given = env.INITIAL_ADMIN_PASSWORD;
  const password = given || crypto.randomUUID();
  await setAccountPassword(vfs, ADMIN_ACCESS, userPath, password, env);
  return given ? { set: 'given' } : { set: 'random', password };
}
