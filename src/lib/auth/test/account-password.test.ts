/**
 * `passwordSignIn`: a failure tells a guesser nothing about which accounts exist, by its message
 * or by its time, and an account's refusal shows only to someone with its password.
 */

import { assertEquals, assertGreater, assertRejects } from '@std/assert';
import { ADMIN_ACCESS } from '../../access/mod.ts';
import { createTestContext, testCommands } from '../../../testing/mod.ts';
import { AUTHENTICATION_FAILED, passwordSignIn, setAccountPassword } from '../account-password.ts';
import { SignInThrottle } from '../sign-in-throttle.ts';

const testCtx = createTestContext({ boot: true });

/** A cost high enough that one hash is far slower than a lookup, low enough for the fast tier. */
const ENV = { CFG_PASSWORD_HASH_LOGN: '14' };

Deno.test({
  name: 'passwordSignIn',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  const cmd = testCommands(admin);
  // A throttle of the test's own that never waits, so a failure takes what its check costs.
  const origin = () => ({ env: ENV, throttle: new SignInThrottle({ now: () => Date.now(), sleep: () => Promise.resolve() }) });
  try {
    await cmd.shouldSucceed('user-create anna');
    await cmd.shouldSucceed('user-create bo');
    await cmd.shouldSucceed('user-create nopass');
    await setAccountPassword(vfs, ADMIN_ACCESS, '/etc/users/anna', 'hunter2', ENV);
    await setAccountPassword(vfs, ADMIN_ACCESS, '/etc/users/bo', 'swordfish', ENV);
    await cmd.shouldSucceed('user-disable bo');

    await t.step('the right password signs in', async () => {
      assertEquals((await passwordSignIn(vfs, 'anna', 'hunter2', origin())).username, 'anna');
    });

    await t.step('an unknown account, a wrong password, no password and a disabled one guessed wrong fail alike', async () => {
      for (const [name, password] of [['nobody-here', 'hunter2'], ['anna', 'wrong'], ['nopass', 'hunter2'], ['bo', 'wrong']]) {
        await assertRejects(() => passwordSignIn(vfs, name, password, origin()), Error, AUTHENTICATION_FAILED);
      }
    });

    await t.step("a disabled account's reason shows only with its right password", async () => {
      await assertRejects(() => passwordSignIn(vfs, 'bo', 'swordfish', origin()), Error, 'account disabled');
    });

    await t.step('an unknown account costs a hash, as a wrong password does', async () => {
      const timed = async (name: string): Promise<number> => {
        const times: number[] = [];
        for (let i = 0; i < 3; i++) {
          const start = performance.now();
          await passwordSignIn(vfs, name, 'wrong', origin()).catch(() => {});
          times.push(performance.now() - start);
        }
        return times.sort((a, b) => a - b)[1];
      };
      const wrong = await timed('anna');
      // Far apart without the dummy hash: a lookup against a hash at logN 14.
      assertGreater(await timed('nobody-here'), wrong / 4);
      assertGreater(await timed('nopass'), wrong / 4);
    });
  } finally {
    admin.close();
    await testCtx.teardown();
  }
});
