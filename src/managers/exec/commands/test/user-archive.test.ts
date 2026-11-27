/**
 * An account nobody used leaves nothing behind: disabling it removes its home when that holds
 * nothing but directories, enabling it makes the home again, and `user-delete --unused` deletes it
 * only when nothing outside it names its uid.
 */

import { assertEquals } from '@std/assert';
import type { UserInactive } from '../../../../lib/api/users.ts';
import { createTestContext, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });

Deno.test({
  name: 'user-disable archives an empty home, user-delete --unused deletes an account nothing names',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  try {
    const cmd = testCommands(admin);
    await cmd.shouldSucceed('user-create bo && user-create cy && user-create dee');
    const boUid = (await admin.execJson<{ uid: number }>('attrs /etc/users/bo')).uid;

    await t.step('a home of empty directories goes when the account is disabled, and comes back empty when enabled', async () => {
      await cmd.shouldSucceed('mkdir -p /home/bo/staging/files/inbox');
      assertEquals(await admin.execJson<UserInactive>('user-disable bo'), { username: 'bo', inactive: true, homeRemoved: true });
      await cmd.shouldFail('test -e /home/bo');
      assertEquals(await admin.execJson<UserInactive>('user-enable bo'), { username: 'bo', inactive: false, homeMade: true });
      const home = await admin.execJson<{ props: { uid: number; gid: number } }>('stat /home/bo');
      assertEquals([home.props.uid, home.props.gid], [boUid, boUid]);
      assertEquals(await admin.execJson<unknown[]>('ls /home/bo'), []);
    });

    await t.step('a home with a file in it stays', async () => {
      await cmd.shouldSucceed('mkdir -p /home/cy/notes && echo hello > /home/cy/notes/todo.txt');
      assertEquals(await admin.execJson<UserInactive>('user-disable cy'), { username: 'cy', inactive: true, homeRemoved: false });
      await cmd.shouldSucceed('test -e /home/cy/notes/todo.txt');
      assertEquals(await admin.execJson<UserInactive>('user-enable cy'), { username: 'cy', inactive: false, homeMade: false });
    });

    await t.step('user-delete --unused refuses an account something names, and says what', async () => {
      await cmd.shouldFailWith('user-delete cy --unused', 'its home holds more than directories');
      await cmd.shouldSucceed('mkdir /home/admin/shared && chown dee /home/admin/shared');
      await cmd.shouldFailWith('user-delete dee --unused', 'it owns 1 node');
      await cmd.shouldFailWith('user-delete dee --unused --to admin', 'takes no --to');
      await cmd.shouldSucceed('test -e /etc/users/dee && test -e /etc/users/cy');
    });

    await t.step('user-delete --unused deletes an account nothing names, its group with it', async () => {
      await cmd.shouldSucceed('user-disable bo && user-delete bo --unused');
      await cmd.shouldFail('test -e /etc/users/bo');
      await cmd.shouldFail('test -e /etc/groups/bo');
    });
  } finally {
    admin.close();
    await testCtx.teardown();
  }
});
