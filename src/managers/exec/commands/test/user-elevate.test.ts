/**
 * A member of the `sudo` group makes a sign-in of theirs the administrator's by entering their
 * password again (`user-elevate`): for one shell, or for the session and every page and terminal
 * it opens. Leaving it, signing in again or being taken out of the group ends it.
 */

import { assert, assertEquals } from '@std/assert';
import type { Whoami } from '../../../../lib/api/mod.ts';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { SESSIONS_PATH } from '../../../../lib/paths.ts';
import { type ShellClient, SystemTestHarness, testCommands } from '../../../../testing/mod.ts';
import type { SessionAttrs } from '../../../../vfs/types/session.ts';

const harness = new SystemTestHarness({ boot: true });

/** A file only the administrator may read. */
const PROBE = '/tmp/elevate-probe';

Deno.test({
  name: 'user-elevate',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const primary = await harness.startPrimary();
  const clients: ShellClient[] = [];
  const open = async (opts?: { username?: string; password?: string; login?: boolean }) => {
    const client = await harness.createShellClient(opts);
    clients.push(client);
    return client;
  };

  try {
    const admin = await open();
    const cmd = testCommands(admin);
    await cmd.shouldSucceed('user-create anna && user-passwd anna --new-password secret && group-add-member sudo anna');
    await cmd.shouldSucceed('user-create bert && user-passwd bert --new-password secret');
    await cmd.shouldSucceed(`echo secret > ${PROBE} && chmod 600 ${PROBE}`);
    const annaUid = (await admin.execJson<{ uid: number }>('attrs /etc/users/anna')).uid;
    const whoami = (client: ShellClient) => client.execJson<Whoami>('user-whoami');
    /** Anna's sessions, as the administrator reads them. */
    const annaSessions = async () => (await primary.vfs.children<SessionAttrs>(ADMIN_ACCESS, SESSIONS_PATH)).filter((entry) => entry.node.attrs.access?.uid === annaUid);

    await t.step('boot makes the sudo group', async () => {
      await cmd.shouldSucceed('group-exists sudo');
    });

    await t.step('a member elevates her shell with her own password, and leaves it', async () => {
      const anna = await open({ username: 'anna', password: 'secret' });
      const as = testCommands(anna);
      const before = await whoami(anna);
      assertEquals([before.admin, before.elevated, before.mayElevate], [false, false, true]);
      await as.shouldFail(`cat ${PROBE}`);

      await as.shouldFailWith('user-elevate --password=wrong', 'authentication failed');
      assertEquals((await whoami(anna)).admin, false);

      await as.shouldSucceed('user-elevate --password=secret');
      const after = await whoami(anna);
      assertEquals([after.admin, after.elevated], [true, true]);
      await as.shouldSucceed(`cat ${PROBE}`);
      await as.shouldSucceed('group-members users');

      await as.shouldSucceed('user-elevate --off');
      assertEquals((await whoami(anna)).admin, false);
      await as.shouldFail(`cat ${PROBE}`);
    });

    await t.step('admin elevates this terminal alone, and admin --off leaves it', async () => {
      const anna = await open({ username: 'anna', password: 'secret' });
      const other = await open({ username: 'anna', password: 'secret' });
      const as = testCommands(anna);
      await as.shouldSucceed('admin --password=secret');
      assertEquals((await whoami(anna)).elevated, true);
      assertEquals((await whoami(other)).elevated, false);
      await as.shouldSucceed(`cat ${PROBE}`);

      await as.shouldSucceed('admin --off');
      assertEquals((await whoami(anna)).admin, false);
    });

    await t.step('someone outside sudo, the administrator and the guest cannot', async () => {
      const bert = await open({ username: 'bert', password: 'secret' });
      assertEquals((await whoami(bert)).mayElevate, false);
      await testCommands(bert).shouldFailWith('user-elevate --password=secret', 'not in the sudo group');
      assertEquals((await whoami(bert)).admin, false);

      await cmd.shouldFailWith('user-elevate --password=admin', 'already an administrator');
      const guest = await open({ login: false });
      await testCommands(guest).shouldFailWith('user-elevate --password=secret', 'sign in first');
    });

    await t.step('attrs on her account do not make her look elevated', async () => {
      const anna = await open({ username: 'anna', password: 'secret' });
      await testCommands(anna).shouldFail('attrs -J elevated=true /etc/users/anna');
      await cmd.shouldSucceed('attrs -J elevated=true /etc/users/anna');
      const who = await whoami(anna);
      assertEquals([who.admin, who.elevated], [false, false]);
      await cmd.shouldSucceed('attrs -J elevated=null /etc/users/anna');
    });

    await t.step('signing in again ends an elevated shell', async () => {
      const anna = await open({ username: 'anna', password: 'secret' });
      await testCommands(anna).shouldSucceed('user-elevate --password=secret && login anna secret');
      assertEquals((await whoami(anna)).admin, false);
    });

    await t.step("an elevated session's later connections are elevated, until she leaves it", async () => {
      // Signed in the way the UI signs in: into the socket's session.
      const browser = await open({ login: false });
      const as = testCommands(browser);
      await as.shouldSucceed('login --session anna secret');
      await as.shouldSucceed('user-elevate --session --password=secret');
      assertEquals((await annaSessions()).filter((entry) => entry.node.attrs.access.elevated === true).length, 1);

      await as.shouldSucceed('user-elevate --session --off');
      assertEquals((await annaSessions()).filter((entry) => entry.node.attrs.access.elevated === true).length, 0);
      assertEquals((await whoami(browser)).admin, false);
    });

    await t.step('a request in an elevated session reads as the administrator', async () => {
      const elevated = await harness.createHttpSession({ uid: annaUid, gid: annaUid, gids: [annaUid], elevated: true });
      const plain = await harness.createHttpSession({ uid: annaUid, gid: annaUid, gids: [annaUid] });
      const read = async (cookie: string) => {
        const res = await fetch(`${primary.baseUrl}/file${PROBE}`, { headers: { cookie } });
        await res.body?.cancel();
        return res.ok;
      };
      assertEquals(await read(elevated.cookie), true);
      assertEquals(await read(plain.cookie), false);
      await cmd.shouldSucceed(`rm ${elevated.sessionPath} ${plain.sessionPath}`);
    });

    await t.step('taking her out of sudo ends every elevation of hers at once', async () => {
      const anna = await open({ username: 'anna', password: 'secret' });
      const browser = await open({ login: false });
      await testCommands(browser).shouldSucceed('login --session anna secret && user-elevate --session --password=secret');
      await testCommands(anna).shouldSucceed('user-elevate --password=secret');
      await testCommands(anna).shouldSucceed('sleep 300 &');
      const elevatedRunning = () => primary.cem.states().filter((s) => s.state === 'running' && s.opts?.access.uid === annaUid && s.opts.access.elevated === true);
      assert(elevatedRunning().length >= 1, 'a command runs elevated before she is taken out');

      await cmd.shouldSucceed('group-remove-member sudo anna');

      assertEquals((await whoami(anna)).admin, false);
      assertEquals((await whoami(browser)).admin, false);
      assertEquals((await annaSessions()).filter((entry) => entry.node.attrs.access.elevated === true).length, 0);
      assertEquals(elevatedRunning().map((s) => s.name), []);
      await testCommands(anna).shouldFailWith('user-elevate --password=secret', 'not in the sudo group');
    });

    /**
     * Make anna a member of sudo with `join`, elevate a shell and the session of a second sign-in
     * of hers, then make `change` as the administrator.
     */
    const elevateThen = async (change: string, join = 'group-add-member sudo anna') => {
      await cmd.shouldSucceed(join);
      const anna = await open({ username: 'anna', password: 'secret' });
      const browser = await open({ login: false });
      await testCommands(browser).shouldSucceed('login --session anna secret && user-elevate --session --password=secret');
      await testCommands(anna).shouldSucceed('user-elevate --password=secret');
      assertEquals((await whoami(anna)).admin, true);

      await cmd.shouldSucceed(change);

      assertEquals((await whoami(anna)).admin, false);
      assertEquals((await whoami(browser)).admin, false);
      assertEquals((await annaSessions()).filter((entry) => entry.node.attrs.access.elevated === true).length, 0);
    };

    await t.step('removing her membership link by hand ends her elevations', async () => {
      await elevateThen('rm /etc/groups/sudo/users/anna');
    });

    await t.step('moving her membership link out of the group ends her elevations', async () => {
      await elevateThen('mkdir /var/elevate-probe && mv /etc/groups/sudo/users/anna /var/elevate-probe/anna');
      await cmd.shouldSucceed('rm -r /var/elevate-probe');
    });

    await t.step('moving her primary group away from sudo ends her elevations', async () => {
      await elevateThen('user-set-primary-group anna anna', 'user-set-primary-group anna sudo');
    });

    await t.step('a change elsewhere in the groups leaves a member elevated', async () => {
      await cmd.shouldSucceed('group-add-member sudo anna');
      const anna = await open({ username: 'anna', password: 'secret' });
      await testCommands(anna).shouldSucceed('user-elevate --password=secret');
      await cmd.shouldSucceed('group-add-member ssh anna && group-remove-member ssh anna');
      assertEquals((await whoami(anna)).admin, true);
      await cmd.shouldSucceed('group-remove-member sudo anna');
    });
  } finally {
    for (const client of clients) client.close();
    await harness.stop();
  }
});
