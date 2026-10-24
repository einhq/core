/**
 * mkfile: core's script around mknode.
 */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

Deno.test({
  name: 'mkfile command',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await t.step('creates an empty text file', async () => {
      await cmd.shouldSucceed('mkfile /testfile');

      const names = await client.execJson<string[]>('ls /');
      assertEquals(names.includes('testfile'), true);

      const attrs = await client.execJson<{ mimetype: string; size: number }>('attrs /testfile');
      assertEquals(attrs.mimetype, 'text/plain');
    });

    await t.step('content can be written with redirection', async () => {
      await client.exec('echo "Hello World" > /testfile');
      const content = await client.execString('cat /testfile');
      assertEquals(content.trim(), 'Hello World');
    });

    await t.step('is idempotent for existing file', async () => {
      await cmd.shouldSucceed('mkfile /testfile');
    });

    await t.step('creates missing parent directories', async () => {
      await cmd.shouldSucceed('mkfile /made/up/dir/file');
      await cmd.shouldSucceed('cat /made/up/dir/file');
    });

    await t.step('creates file in subdirectory', async () => {
      await client.exec('mkdir /subdir');
      await cmd.shouldSucceed('mkfile /subdir/file');
      await client.exec('echo "content in subdir" > /subdir/file');

      const content = await client.execString('cat /subdir/file');
      assertEquals(content.trim(), 'content in subdir');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
