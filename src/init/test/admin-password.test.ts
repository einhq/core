/**
 * `setFirstAdminPassword`: a new instance's administrator gets the deployment's password, or a
 * random one, and an account that has a password keeps it.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { isAccountPassword } from '../../lib/auth/account-password.ts';
import { createTestContext } from '../../testing/mod.ts';
import { setFirstAdminPassword } from '../admin-password.ts';

const testCtx = createTestContext({ boot: true });

const ADMIN = '/etc/users/admin';
const ENV = { CFG_PASSWORD_HASH_LOGN: '10' };

Deno.test({ name: 'setFirstAdminPassword', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  try {
    await t.step('an account with a password keeps it', async () => {
      assertEquals(await setFirstAdminPassword(vfs, { ...ENV, INITIAL_ADMIN_PASSWORD: "it's $HOME" }), { set: 'none' });
      assertEquals(await isAccountPassword(vfs, ADMIN, 'admin'), true);
    });

    await vfs.unlink(ADMIN_ACCESS, `${ADMIN}/.password`, ADMIN);

    await t.step("a new instance's administrator gets INITIAL_ADMIN_PASSWORD as it is", async () => {
      assertEquals(await setFirstAdminPassword(vfs, { ...ENV, INITIAL_ADMIN_PASSWORD: "it's $HOME" }), { set: 'given' });
      assertEquals(await isAccountPassword(vfs, ADMIN, "it's $HOME"), true);
    });

    await vfs.unlink(ADMIN_ACCESS, `${ADMIN}/.password`, ADMIN);

    await t.step('without one it gets a random password, which it returns', async () => {
      const result = await setFirstAdminPassword(vfs, { ...ENV, INITIAL_ADMIN_PASSWORD: '' });
      assertEquals(result.set, 'random');
      assertEquals(result.set === 'random' && await isAccountPassword(vfs, ADMIN, result.password), true);
    });
  } finally {
    await testCtx.teardown();
  }
});
