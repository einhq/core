/**
 * `accessOfUser`: the access an account signs in with, read from its user node, for work done on
 * its behalf.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { ADMIN_ACCESS, USERS_GID } from '../../access/mod.ts';
import { createTestContext, testCommands } from '../../../testing/mod.ts';
import { accessOfUser } from '../member-gids.ts';

const testCtx = createTestContext({ boot: true });

Deno.test({
  name: 'accessOfUser',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  const cmd = testCommands(admin);
  try {
    await cmd.shouldSucceed('group-create family --gid 7300');
    await cmd.shouldSucceed('user-create anna --uid 3100');
    await cmd.shouldSucceed('group-add-member family anna');

    await t.step('carries the uid, the primary group and every group the account is linked into', async () => {
      const userNode = await vfs.get(ADMIN_ACCESS, '/etc/users/anna');
      const access = await accessOfUser(vfs, ADMIN_ACCESS, 'anna');
      assertEquals(access.uid, 3100);
      assertEquals(access.gid, userNode.attrs.gid);
      assertEquals([...access.gids].sort(), [...new Set([USERS_GID, userNode.attrs.gid, 7300])].sort());
      assertEquals(access.admin, undefined);
    });

    await t.step('a name that is no account is refused', async () => {
      await assertRejects(() => accessOfUser(vfs, ADMIN_ACCESS, 'nobody-here'));
      await cmd.shouldSucceed('mkdir -p /etc/users/not-a-user');
      await assertRejects(() => accessOfUser(vfs, ADMIN_ACCESS, 'not-a-user'), Error, 'not a user');
    });
  } finally {
    admin.close();
    await testCtx.teardown();
  }
});
