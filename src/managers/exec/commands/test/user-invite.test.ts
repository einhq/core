/**
 * Sign-in links: only an administrator makes, shows or takes one away; whoever holds one sees which
 * account it is for and chooses its password once, which clears the reset gate and signs in; a
 * spent, replaced, expired or taken-away link, and one for a disabled account, opens nothing.
 */

import { assert, assertEquals, assertMatch } from '@std/assert';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import type { UserEntry, UserInvite, UserInviteAccepted, Whoami } from '../../../../lib/api/users.ts';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });

const DAY_MS = 24 * 60 * 60 * 1000;

Deno.test({
  name: 'sign-in links',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  const cmd = testCommands(admin);
  const clients: ShellClient[] = [admin];
  const guest = async (): Promise<ShellClient> => {
    const client = await testCtx.server.createShellClient({ login: false });
    clients.push(client);
    return client;
  };
  const invite = (args: string) => admin.execJson<UserInvite>(`user-invite ${args}`);

  try {
    await t.step('setup: an imported account with no password, which may not sign in', async () => {
      await cmd.shouldSucceed('user-create anna --title "Anna Andersson" --email anna@example.com');
      await cmd.shouldSucceed('attrs -J mustResetPassword=true /etc/users/anna');
      await cmd.shouldSucceed('user-create bo');
      await cmd.shouldSucceed('user-passwd bo --new-password=bo-secret');
    });

    await t.step('an account has no link until an administrator makes one, for 7 days unless told', async () => {
      assertEquals(await invite('anna'), { username: 'anna' });
      const made = await invite('anna --new');
      assertMatch(made.token!, /^[A-Za-z0-9]{22}$/);
      assert(Math.abs(made.expiresAt! - (Date.now() + 7 * DAY_MS)) < 60_000);
      assertEquals(await invite('anna'), made);
      const longer = await invite('anna --new --days 30');
      assert(Math.abs(longer.expiresAt! - (Date.now() + 30 * DAY_MS)) < 60_000);
      // The link is the administrator's alone, like the password.
      assertEquals((await vfs.get(ADMIN_ACCESS, '/etc/users/anna/.invite')).props.mode & 0o077, 0);
    });

    await t.step('only an administrator makes one, never for the guest, a disabled account or out of range', async () => {
      const bo = await testCtx.server.createShellClient({ username: 'bo', password: 'bo-secret' });
      clients.push(bo);
      assertEquals((await bo.exec('user-invite anna --new')).success, false);
      assertEquals((await bo.exec('user-invite anna')).success, false);
      assertEquals((await admin.exec('user-invite guest --new')).success, false);
      assertEquals((await admin.exec('user-invite nobody --new')).success, false);
      assertEquals((await admin.exec('user-invite anna --new --days 91')).success, false);
      assertEquals((await admin.exec('user-invite anna --days 3')).success, false);
    });

    await t.step('a new link replaces the old one, which opens nothing', async () => {
      const old = await invite('anna --new');
      const current = await invite('anna --new');
      const visitor = await guest();
      assertEquals((await visitor.exec(`user-invite-accept ${old.token}`)).success, false);
      assertEquals((await visitor.exec('user-invite-accept AAAAAAAAAAAAAAAAAAAAAA')).success, false);
      assertEquals((await visitor.exec('user-invite-accept not-a-token')).success, false);
      assertEquals(await visitor.execJson<UserInviteAccepted>(`user-invite-accept ${current.token}`), {
        username: 'anna',
        title: 'Anna Andersson',
        email: 'anna@example.com',
        signedIn: false,
      });
    });

    await t.step('choosing a password with it signs in, clears the gate and spends the link', async () => {
      const { token } = await invite('anna');
      const visitor = await guest();
      assertEquals((await visitor.exec(`user-invite-accept ${token} --password=`)).success, false);
      const accepted = await visitor.execJson<UserInviteAccepted>(`user-invite-accept ${token} --password=anna-secret --session`);
      assertEquals(accepted, { username: 'anna', title: 'Anna Andersson', email: 'anna@example.com', signedIn: true });
      assertEquals((await visitor.execJson<Whoami>('user-whoami')).username, 'anna');

      const anna = (await admin.execJson<UserEntry[]>('user-list')).find((entry) => entry.username === 'anna');
      assertEquals([anna?.mustResetPassword, anna?.hasPassword], [false, true]);
      assertEquals(await invite('anna'), { username: 'anna' });

      const again = await guest();
      assertEquals((await again.exec(`user-invite-accept ${token} --password=other`)).success, false);
      const signedIn = await testCtx.server.createShellClient({ username: 'anna', password: 'anna-secret' });
      clients.push(signedIn);
      assertEquals((await signedIn.execJson<Whoami>('user-whoami')).username, 'anna');
    });

    await t.step('a forgotten password: a link replaces it', async () => {
      const { token } = await invite('bo --new');
      await (await guest()).execJson<UserInviteAccepted>(`user-invite-accept ${token} --password=bo-new`);
      assertEquals((await admin.exec('login bo bo-secret')).success, false);
      const bo = await testCtx.server.createShellClient({ username: 'bo', password: 'bo-new' });
      clients.push(bo);
    });

    await t.step('a link taken away, or of a disabled account, opens nothing', async () => {
      const taken = await invite('bo --new');
      assertEquals(await invite('bo --off'), { username: 'bo' });
      assertEquals((await (await guest()).exec(`user-invite-accept ${taken.token}`)).success, false);

      const kept = await invite('bo --new');
      await cmd.shouldSucceed('user-disable bo');
      assertEquals((await (await guest()).exec(`user-invite-accept ${kept.token}`)).success, false);
      await cmd.shouldSucceed('user-enable bo');
      assertEquals((await (await guest()).execJson<UserInviteAccepted>(`user-invite-accept ${kept.token}`)).username, 'bo');
    });

    await t.step('an expired link opens nothing', async () => {
      const { token } = await invite('bo --new');
      await vfs.update(ADMIN_ACCESS, '/etc/users/bo/.invite', { attrs: { expiresAt: Date.now() - 1 } });
      assertEquals((await (await guest()).exec(`user-invite-accept ${token}`)).success, false);
      assertEquals(await invite('bo'), { username: 'bo' });
    });
  } finally {
    for (const client of clients) client.close();
    await testCtx.teardown();
  }
});
