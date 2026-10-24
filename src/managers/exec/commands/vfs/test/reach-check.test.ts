/**
 * `reach-check`: stored reach agrees with a walk of each path for every account, after closed
 * directories, a hard link out of one and an access-list grant; and only administrators run it.
 */

import { assertEquals } from '@std/assert';
import type { ReachCheck } from '../../../../../lib/api/mod.ts';
import { createTestContext, testCommands } from '../../../../../testing/mod.ts';

const testCtx = createTestContext();

Deno.test({
  name: 'reach-check',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await t.step('setup: two accounts, a closed folder, a hard link out of it and a grant into another', async () => {
      await cmd.shouldSucceed('user-create anna');
      await cmd.shouldSucceed('user-passwd anna --new-password secret1');
      await cmd.shouldSucceed('user-create bertil');
      await cmd.shouldSucceed('mkdir -p /check/closed/inner /check/granted /check/open');
      await cmd.shouldSucceed('chmod 700 /check/closed');
      await cmd.shouldSucceed('chmod 700 /check/granted');
      await cmd.shouldSucceed('echo a sailboat > /check/closed/inner/boat.txt');
      await cmd.shouldSucceed('echo a lighthouse > /check/granted/light.txt');
      await cmd.shouldSucceed('ln /check/closed/inner/boat.txt /check/open/boat.txt');
      await cmd.shouldSucceed('acl /check/granted --add-user anna:rx');
    });

    await t.step('stored reach agrees with the walk, and names nobody unknown', async () => {
      const check = await client.execJson<ReachCheck>('reach-check --sample 500');
      assertEquals(check.mismatches, []);
      assertEquals(check.unknown, { uids: [], gids: [] });
      assertEquals(check.callers >= 3, true);
      assertEquals(check.sampled > 0, true);
    });

    await t.step('only administrators run it', async () => {
      const anna = await testCtx.server.createShellClient({ username: 'anna', password: 'secret1' });
      try {
        await testCommands(anna).shouldFail('reach-check');
      } finally {
        anna.close();
      }
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
