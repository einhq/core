/**
 * `passwordSignIn`: a failure tells a guesser nothing about which accounts exist, by its message
 * or by its time, and an account's refusal shows only to someone with its password.
 * `checkAccountPassword`: a check of a known account's password is throttled as a sign-in is.
 */

import { assertEquals, assertGreater, assertRejects } from '@std/assert';
import { ADMIN_ACCESS } from '../../access/mod.ts';
import { createTestContext, testCommands } from '../../../testing/mod.ts';
import { AUTHENTICATION_FAILED, checkAccountPassword, passwordSignIn, setAccountPassword } from '../account-password.ts';
import { FREE_FAILURES, SignInThrottle } from '../sign-in-throttle.ts';

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

    await t.step('a username is spelled one way: a path to the account is no name for it', async () => {
      assertEquals((await passwordSignIn(vfs, ' Anna ', 'hunter2', origin())).username, 'anna');
      for (const name of ['./anna', 'x/../anna', 'a/b/../../anna', '../users/anna', '.', '..', '/etc/users/anna']) {
        await assertRejects(() => passwordSignIn(vfs, name, 'hunter2', origin()), Error, AUTHENTICATION_FAILED, name);
      }
    });

    await t.step("a disabled account's reason shows only with its right password", async () => {
      await assertRejects(() => passwordSignIn(vfs, 'bo', 'swordfish', origin()), Error, 'account disabled');
    });

    await t.step('checking a password waits out a failure and counts it, as a sign-in does', async () => {
      const now = 1_000_000;
      const waits: number[] = [];
      const throttle = new SignInThrottle({ now: () => now, sleep: (ms) => (waits.push(ms), Promise.resolve()) });
      const check = (password: string) => checkAccountPassword(vfs, '/etc/users/anna', password, { from: '192.0.2.7', throttle });

      assertEquals(await check('hunter2'), true);
      assertEquals(waits, []);
      assertEquals(await check('wrong'), false);
      assertEquals(waits, [1000]);
      for (let i = 1; i < FREE_FAILURES; i++) await check('wrong');
      await assertRejects(() => check('hunter2'), Error, 'too many failed sign-ins');
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
