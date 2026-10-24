/**
 * The archive is open to the guest only where the system's files say so: the administrator's
 * setting or the deployment's, never the default.
 */

import { assert, assertEquals } from '@std/assert';
import type { Whoami } from '../../api/mod.ts';
import { createTestContext, testCommands } from '../../../testing/mod.ts';
import { guestMayBrowse } from '../read-settings.ts';

const testCtx = createTestContext({ boot: true });

Deno.test({
  name: 'guestMayBrowse',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  const cmd = testCommands(admin);

  try {
    await t.step('closed by default', async () => {
      assertEquals(await guestMayBrowse(vfs), false);
    });

    await t.step("open by the administrator's setting, and closed again when it is unset", async () => {
      await cmd.shouldSucceed('config set CFG_GUEST_BROWSING true');
      assertEquals(await guestMayBrowse(vfs), true);
      await cmd.shouldSucceed('config set CFG_GUEST_BROWSING false');
      assertEquals(await guestMayBrowse(vfs), false);
      await cmd.shouldSucceed('config unset CFG_GUEST_BROWSING');
      assertEquals(await guestMayBrowse(vfs), false);
    });

    await t.step("open by the deployment's environment", async () => {
      await cmd.shouldSucceed(`echo "export CFG_GUEST_BROWSING='true'" >> /etc/environment`);
      assertEquals(await guestMayBrowse(vfs), true);
      // The administrator's setting wins over the deployment's, as sourcing has it.
      await cmd.shouldSucceed('config set CFG_GUEST_BROWSING false');
      assertEquals(await guestMayBrowse(vfs), false);
    });

    await t.step('the guest runs what signing in takes and nothing else, until visitors may browse', async () => {
      await cmd.shouldSucceed('config set CFG_GUEST_BROWSING false');
      const guest = await testCtx.server.createShellClient({ login: false });
      try {
        assertEquals((await guest.execJson<Whoami>('user-whoami')).username, 'guest');
        assertEquals((await guest.exec('config list --scope user')).success, true);
        const refused = await guest.exec('ls /');
        assertEquals([refused.success, refused.error?.includes('sign in first')], [false, true]);
        // Its own command line does not open the archive to it.
        assertEquals((await guest.exec('CFG_GUEST_BROWSING=true ls /')).success, false);

        await cmd.shouldSucceed('config set CFG_GUEST_BROWSING true');
        assertEquals((await guest.exec('ls /')).success, true);
      } finally {
        await cmd.shouldSucceed('config set CFG_GUEST_BROWSING false');
        guest.close();
      }
    });

    await t.step("the guest's shell reaches no file by itself either, until visitors may browse", async () => {
      await cmd.shouldSucceed('mkdir /visitors && echo hello > /visitors/note.txt');
      await cmd.shouldSucceed("share-set /visitors --mode 0700 -m 'g:guest:rx'");
      const guest = await testCtx.server.createShellClient({ login: false });
      try {
        // A builtin or a command by its path is refused as such.
        for (const line of ['echo hello', 'cd /visitors', 'source /visitors/note.txt', '/bin/user-whoami']) {
          const result = await guest.exec(line, { json: false });
          assertEquals([line, result.success], [line, false]);
          assert(result.error?.includes('sign in first'), `${line}: ${result.error}`);
        }
        // A redirection, `$(< file)`, a glob or a file test finds nothing there.
        for (
          const line of [
            'read line < /visitors/note.txt',
            'user-whoami < /visitors/note.txt',
            'user-whoami > /visitors/out.txt',
            'login "$(< /visitors/note.txt)" x',
            'login /visitors/* x',
            '[[ -e /visitors/note.txt ]]',
          ]
        ) {
          const result = await guest.exec(line, { json: false });
          assertEquals([line, result.success, result.data], [line, false, null]);
        }
        assertEquals((await guest.vfs('get', ['/visitors/note.txt'])).error, 'sign in first');
        assertEquals((await admin.exec('stat /visitors/out.txt')).success, false);

        await cmd.shouldSucceed('config set CFG_GUEST_BROWSING true');
        assertEquals((await guest.execString('read line < /visitors/note.txt; echo "$line"', { json: false })).trim(), 'hello');
        assertEquals((await guest.vfs('get', ['/visitors/note.txt'])).success, true);
      } finally {
        await cmd.shouldSucceed('config set CFG_GUEST_BROWSING false');
        guest.close();
      }
    });

    await t.step('user-whoami tells the guest and the signed-in alike', async () => {
      const guest = await testCtx.server.createShellClient({ login: false });
      try {
        assertEquals((await guest.execJson<Whoami>('user-whoami')).guestBrowsing, false);
        assertEquals((await admin.execJson<Whoami>('user-whoami')).guestBrowsing, false);
        // Its own command line does not open the archive to it.
        assertEquals((await guest.execJson<Whoami>('CFG_GUEST_BROWSING=true user-whoami')).guestBrowsing, false);
        await cmd.shouldSucceed('config set CFG_GUEST_BROWSING true');
        assertEquals((await guest.execJson<Whoami>('user-whoami')).guestBrowsing, true);
        assertEquals((await admin.execJson<Whoami>('user-whoami')).guestBrowsing, true);
      } finally {
        await cmd.shouldSucceed('config unset CFG_GUEST_BROWSING');
        guest.close();
      }
    });

    await t.step("a module's settings file counts as soon as it changes", async () => {
      // Over the deployment's `true`, under the administrator's, which is unset here.
      await cmd.shouldSucceed('mkdir -p /usr/modules/demo/etc /etc/config.d');
      await cmd.shouldSucceed(`echo "export CFG_GUEST_BROWSING='false'" > /usr/modules/demo/etc/config`);
      await cmd.shouldSucceed('ln -s /usr/modules/demo/etc/config /etc/config.d/demo');
      try {
        assertEquals(await guestMayBrowse(vfs), false);
        await cmd.shouldSucceed(`echo "export CFG_GUEST_BROWSING='true'" > /usr/modules/demo/etc/config`);
        assertEquals(await guestMayBrowse(vfs), true);
        await cmd.shouldSucceed(`echo "export CFG_GUEST_BROWSING='false'" > /usr/modules/demo/etc/config`);
        assertEquals(await guestMayBrowse(vfs), false);
      } finally {
        await cmd.shouldSucceed('rm /etc/config.d/demo && rm -r /usr/modules/demo');
      }
      assertEquals(await guestMayBrowse(vfs), true);
    });
  } finally {
    admin.close();
    await testCtx.teardown();
  }
});
