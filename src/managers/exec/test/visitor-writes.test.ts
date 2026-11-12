/**
 * Someone who has not signed in changes nothing through a command: the guest where visitors may
 * browse, and whoever holds a share link, are refused any call whose spec says it writes, even one
 * that would check who asks and then write as the administrator. They still read, ask a command
 * for its help, and run what signing in and opening a link take.
 */

import { assert, assertEquals } from '@std/assert';
import type { ShareLinkCreated, Whoami } from '../../../lib/api/mod.ts';
import { createTestContext, testCommands } from '../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });

Deno.test({
  name: 'visitors change nothing',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  const cmd = testCommands(admin);

  try {
    await t.step('setup: visitors may browse, and an album is shared by link', async () => {
      await cmd.shouldSucceed('config set CFG_GUEST_BROWSING true');
      await cmd.shouldSucceed('mkdir -p /alb && mkfile /alb/a.txt && share-set /alb --mode 0750 -b && chmod 0755 /');
    });

    await t.step('the guest does not rename its own account, which user-update would write as the administrator', async () => {
      const guest = await testCtx.server.createShellClient({ login: false });
      try {
        const before = await guest.execJson<Whoami>('user-whoami');
        const refused = await guest.exec('user-update guest --name Somebody');
        assertEquals([refused.success, refused.error?.includes('sign in first')], [false, true]);
        assertEquals((await guest.execJson<Whoami>('user-whoami')).name, before.name);
        // What only reads still runs, and so does a write command's help.
        assertEquals((await guest.exec('ls /')).success, true);
        assertEquals((await guest.exec('user-update --help', { json: false })).success, true);
      } finally {
        guest.close();
      }
    });

    await t.step("a link's holder reads what it opens and runs nothing that writes", async () => {
      const created = await admin.execJson<ShareLinkCreated>('share-link create /alb');
      const visitor = await testCtx.server.createShellClient({ login: false });
      try {
        assertEquals((await visitor.exec(`share-link open ${created.link.token} --session`)).success, true);
        assertEquals((await visitor.exec('ls /alb')).success, true);
        const refused = await visitor.exec('user-update guest --name Somebody');
        assertEquals([refused.success, refused.error?.includes('sign in first')], [false, true]);
        assert((await visitor.exec('device-create porch --class sensor')).error?.includes('sign in first'));
      } finally {
        visitor.close();
      }
      await cmd.shouldSucceed(`share-link remove ${created.link.id}`);
    });
  } finally {
    await cmd.shouldSucceed('config set CFG_GUEST_BROWSING false');
    admin.close();
    await testCtx.teardown();
  }
});
