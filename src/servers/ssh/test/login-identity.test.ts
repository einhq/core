/**
 * `login` signs in as the account at `/etc/users/<name>` with that account's groups, whatever the
 * shell's environment says. An ordinary user who points `USERS_PATH` at a link to their own account
 * named like the administrator, and signs in with their own password, is refused, and keeps their
 * own groups: over an SSH exec channel and in an interactive shell on a web session, where commands
 * typed at the shell run in the shell's own environment.
 */

import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { ADMIN_ACCESS, ADMIN_GID } from '../../../lib/access/mod.ts';
import type { UserEntry } from '../../../lib/api/users.ts';
import { InteractiveShell } from '../../../managers/shell/interactive-shell.ts';
import { type ShellClient, SystemTestHarness } from '../../../testing/mod.ts';
import type { SessionAttrs } from '../../../vfs/types/session.ts';

const harness = new SystemTestHarness({ ssh: true, boot: true });

/** Point `USERS_PATH` at `/home/anna/x`, where `admin` is a link to anna's own account. */
const POINT_AT_OWN_HOME = 'export USERS_PATH=/home/anna/x GROUPS_PATH=/etc/groups';

Deno.test({
  name: 'login: the account and its groups come from /etc/users and /etc/groups, not the environment',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const primary = await harness.startPrimary();
  let admin: ShellClient | undefined;

  try {
    admin = await harness.createShellClient();
    await admin.exec('user-create anna && user-passwd anna --new-password secret');
    // Readable through group admin only, which anna is not in.
    await admin.exec('echo top > /admin-note && chown admin:admin /admin-note && chmod 040 /admin-note');
    const anna = (await admin.execJson<UserEntry[]>('user-list')).find((user) => user.username === 'anna');
    assert(anna);
    const asAnna = { username: 'anna', password: 'secret' };

    await t.step("a hard link of an account is the administrator's to make", async () => {
      const linked = await harness.runSSH('mkdir /home/anna/x && ln /etc/users/anna /home/anna/x/admin', asAnna);
      assertEquals(linked.code, 1);
      assertStringIncludes(linked.stdout, "'link user'");
    });

    await t.step('over SSH exec', async () => {
      const result = await harness.runSSH(
        [
          'ln -s /etc/users/anna /home/anna/x/admin',
          POINT_AT_OWN_HOME,
          'login admin secret || echo refused',
          'login --session admin secret || echo refused',
          'cat /admin-note || echo denied',
          'echo "$USER"',
        ].join('\n'),
        asAnna,
      );
      // An exec channel carries what the commands write to stderr on stdout too.
      const lines = result.stdout.split('\n');
      assertEquals(lines.filter((line) => !line.includes(': ')), ['refused', 'refused', 'denied', 'anna', '']);
      assertEquals(lines.filter((line) => line === 'login: authentication failed').length, 2);
    });

    await t.step('in an interactive shell on a web session', async () => {
      const access = { uid: anna.uid, gid: anna.gid, gids: [anna.gid] };
      const { sessionPath } = await harness.createHttpSession(access);
      const shell = new InteractiveShell({ vfs: primary.vfs, cem: primary.cem, bufferManager: primary.bufferManager, sessionPath, origin: 'terminal' });
      await shell.open();
      try {
        assertEquals(await shell.run(POINT_AT_OWN_HOME), 0);
        assertEquals(await shell.run('login admin secret'), 1);
        assertEquals(await shell.run('login --session admin secret'), 1);

        assertEquals(shell.getAccess().uid, anna.uid);
        assertEquals(shell.getAccess().gids.includes(ADMIN_GID), false);
        const session = await primary.vfs.get<SessionAttrs>(ADMIN_ACCESS, sessionPath);
        assertEquals(session.attrs.access, access);
      } finally {
        await shell.close();
      }
    });
  } finally {
    admin?.close();
    await harness.stop();
  }
});
