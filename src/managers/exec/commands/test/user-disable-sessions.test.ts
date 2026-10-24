/**
 * Disabling or deleting an account ends what it already has open: its web
 * sessions, the shells acting as it, its SSH connections and the commands
 * still running as it.
 */

import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, GUEST_UID } from '../../../../lib/access/mod.ts';
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
  name: 'user-disable ends open sessions',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const primary = await harness.startPrimary();
  let admin: ShellClient | undefined;
  let anna: ShellClient | undefined;
  let browser: ShellClient | undefined;
  let bert: ShellClient | undefined;

  try {
    admin = await harness.createShellClient();
    const cmd = testCommands(admin);
    await cmd.shouldSucceed('user-create anna && user-passwd anna --new-password secret');
    const uid = (await admin.execJson<{ uid: number }>('attrs /etc/users/anna')).uid;
    await cmd.shouldSucceed('user-create bert && user-passwd bert --new-password secret');
    const bertUid = (await admin.execJson<{ uid: number }>('attrs /etc/users/bert')).uid;
    const lines = (path: string) => admin!.execString(`wc -l < ${path}`);

    await t.step('the administrator cannot be disabled or deleted', async () => {
      await cmd.shouldFail('user-disable admin');
      await cmd.shouldFail('user-delete admin');
    });

    await t.step('sessions, shells and SSH connections of the account end', async () => {
      anna = await harness.createShellClient({ username: 'anna', password: 'secret' });
      const web = await harness.createHttpSession({ uid, gid: uid, gids: [uid] });
      // Signed in the way the UI signs in: into the socket's session.
      browser = await harness.createShellClient({ login: false });
      await testCommands(browser).shouldSucceed('login --session anna secret');
      const ssh = await harness.connectSSH({ username: 'anna', password: 'secret' });
      const sshClosed = new Promise<true>((resolve) => ssh.on('close', () => resolve(true)));

      await cmd.shouldSucceed('user-disable anna');

      const session = await primary.vfs.get<SessionAttrs>(ADMIN_ACCESS, web.sessionPath);
      assertEquals(session.attrs.expired, true);
      assertEquals(session.attrs.access.uid, GUEST_UID);

      assertEquals(await within(browser.closed), SESSION_ENDED_CLOSE_CODE);
      assertEquals(await within(sshClosed), true, 'the SSH connection is ended');

      const who = await anna.execJson<{ username: string }>('user-whoami');
      assertEquals(who.username, 'guest');
    });

    await t.step('deleting an account ends its sessions too', async () => {
      await cmd.shouldSucceed('user-enable anna');
      const web = await harness.createHttpSession({ uid, gid: uid, gids: [uid] });

      await cmd.shouldSucceed('user-delete anna');

      const session = await primary.vfs.get<SessionAttrs>(ADMIN_ACCESS, web.sessionPath);
      assertEquals(session.attrs.expired, true);
    });

    await t.step('commands still running as the account are killed, detached jobs too', async () => {
      bert = await harness.createShellClient({ username: 'bert', password: 'secret' });
      const runningAsBert = () => primary.cem.states().filter((s) => s.state === 'running' && s.opts?.access.uid === bertUid);

      await testCommands(bert).shouldSucceed('sleep 300 &');
      await testCommands(bert).shouldSucceed('{ while true; do echo x >> /home/bert/beat; sleep 0.05; done; } & disown');
      assert(runningAsBert().length >= 2, 'the jobs are running before the account is disabled');
      // The job is the administrator's, but its steps run as bert, from a shell that has closed.
      const closing = await harness.createShellClient();
      await testCommands(closing).shouldSucceed(
        'login bert secret && { while true; do echo x >> /home/bert/beat-after-close; sleep 0.05; done; } & disown',
      );
      closing.close();
      await new Promise((resolve) => setTimeout(resolve, 200));

      await cmd.shouldSucceed('user-disable bert');

      assertEquals(runningAsBert().map((s) => s.name), []);
      const before = await lines('/home/bert/beat');
      await new Promise((resolve) => setTimeout(resolve, 300));
      assertEquals(await lines('/home/bert/beat'), before, 'the detached loop writes nothing more');
      const afterClose = await lines('/home/bert/beat-after-close');
      await new Promise((resolve) => setTimeout(resolve, 300));
      assertEquals(await lines('/home/bert/beat-after-close'), afterClose, "the closed shell's loop writes nothing more");
    });
  } finally {
    bert?.close();
    browser?.close();
    anna?.close();
    admin?.close();
    await harness.stop();
  }
});
