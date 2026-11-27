/**
 * A password changed or reset ends the account's other sign-ins: its web sessions, the shells
 * acting as it in them and its SSH connections. The session the change is made from goes on, and so
 * does what runs as the account in no session, such as the services. The current password
 * `user-passwd` asks for is tried no faster than a sign-in.
 */

import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, GUEST_UID } from '../../../../lib/access/mod.ts';
import type { UserInvite } from '../../../../lib/api/users.ts';
import { SESSION_ENDED_CLOSE_CODE } from '../../../../servers/http/ws/api-shell-handler.ts';
import { type ShellClient, SystemTestHarness, testCommands } from '../../../../testing/mod.ts';
import type { SessionAttrs } from '../../../../vfs/types/session.ts';

const harness = new SystemTestHarness({ ssh: true, boot: true });

/** `promise`, or `undefined` once `ms` pass without it settling. */
function within<T>(promise: Promise<T>, ms = 5000): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => timer = setTimeout(() => resolve(undefined), ms));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

Deno.test({
  name: 'a password change ends the other sessions',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const instance = await harness.start();
  const clients: ShellClient[] = [];
  const client = async (opts?: Parameters<typeof harness.createShellClient>[0]): Promise<ShellClient> => {
    const made = await harness.createShellClient(opts);
    clients.push(made);
    return made;
  };

  try {
    const admin = await client();
    const cmd = testCommands(admin);
    await cmd.shouldSucceed('user-create anna && user-passwd anna --new-password secret-1');
    const uid = (await admin.execJson<{ uid: number }>('attrs /etc/users/anna')).uid;
    const whoami = async (shell: ShellClient) => (await shell.execJson<{ username: string }>('user-whoami')).username;
    const expired = async (sessionPath: string) => {
      const session = await instance.vfs.get<SessionAttrs>(ADMIN_ACCESS, sessionPath);
      return session.attrs.expired === true && session.attrs.access.uid === GUEST_UID;
    };

    await t.step('a wrong current password is answered no sooner than a failed sign-in, guess after guess', async () => {
      const anna = await client({ username: 'anna', password: 'secret-1' });
      const start = performance.now();
      const guesses = await Promise.all([1, 2, 3].map((i) => anna.exec(`user-passwd anna --old-password guess-${i} --new-password x`)));
      assertEquals(guesses.map((guess) => guess.success), [false, false, false]);
      assert(performance.now() - start >= 1000, 'the guesses were answered at once');
      await testCommands(anna).shouldSucceed('user-passwd anna --old-password secret-1 --new-password secret-2');
    });

    await t.step("changing one's own password ends the other sign-ins and keeps this one", async () => {
      const here = await client({ username: 'anna', password: 'secret-2' });
      const elsewhere = await client({ username: 'anna', password: 'secret-2' });
      const web = await harness.createHttpSession({ uid, gid: uid, gids: [uid] });
      const browser = await client({ login: false });
      await testCommands(browser).shouldSucceed('login --session anna secret-2');
      const ssh = await harness.connectSSH({ username: 'anna', password: 'secret-2' });
      const sshClosed = new Promise<true>((resolve) => ssh.on('close', () => resolve(true)));

      await testCommands(here).shouldSucceed('user-passwd anna --old-password secret-2 --new-password secret-3');

      assert(await expired(web.sessionPath), 'the web session is ended');
      assertEquals(await within(browser.closed), SESSION_ENDED_CLOSE_CODE);
      assertEquals(await within(sshClosed), true, 'the SSH connection is ended');
      assertEquals(await whoami(elsewhere), 'guest');
      assertEquals(await whoami(here), 'anna');
    });

    await t.step('an administrator setting it ends every sign-in of the account', async () => {
      const anna = await client({ username: 'anna', password: 'secret-3' });
      const web = await harness.createHttpSession({ uid, gid: uid, gids: [uid] });

      await cmd.shouldSucceed('user-passwd anna --new-password secret-4');

      assert(await expired(web.sessionPath), 'the web session is ended');
      assertEquals(await whoami(anna), 'guest');
      assertEquals(await whoami(admin), 'admin');
    });

    await t.step('choosing a password with a sign-in link ends the sign-ins before it, and signs in', async () => {
      const anna = await client({ username: 'anna', password: 'secret-4' });
      const web = await harness.createHttpSession({ uid, gid: uid, gids: [uid] });
      const { token } = await admin.execJson<UserInvite>('user-invite anna --new');

      const visitor = await client({ login: false });
      await testCommands(visitor).shouldSucceed(`user-invite-accept ${token} --password=secret-5`);

      assert(await expired(web.sessionPath), 'the web session is ended');
      assertEquals(await whoami(anna), 'guest');
      assertEquals(await whoami(visitor), 'anna');
    });

    await t.step("the administrator's own change leaves what runs in no session, the services, running", async () => {
      // Each running service as it started: one killed and started again starts anew.
      const services = async () =>
        (await admin.execJson<{ name: string; status: string; startedAt: number }[]>('service list'))
          .filter((service) => service.status === 'running').map((service) => `${service.name} ${service.startedAt}`).sort();
      const before = await services();
      assert(before.length > 0, 'services run');
      const other = await client();

      await cmd.shouldSucceed('user-passwd admin --new-password admin-new');

      assertEquals(await whoami(other), 'guest');
      assertEquals(await services(), before);
    });
  } finally {
    for (const each of clients) each.close();
    await harness.stop();
  }
});
