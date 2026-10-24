/** pwd: the working directory, and cd within one script. */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

Deno.test({
  name: 'pwd command',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await t.step('returns current directory', async () => {
      await cmd.shouldSucceed('pwd');
    });

    await t.step('returns root initially', async () => {
      const pwd = await client.execString('pwd');
      // Initial directory is typically / or /home/admin
      assertEquals(typeof pwd, 'string');
      assertEquals(pwd.startsWith('/'), true);
    });

    // Each API shell exec runs in its own spawned context, so cd only
    // persists within a single script, not across exec messages.
    await t.step('reflects directory changes within a script', async () => {
      await client.exec('mkdir -p /test/dir');
      const pwd = await client.execString('cd /test/dir && pwd');
      assertEquals(pwd.trim(), '/test/dir');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
