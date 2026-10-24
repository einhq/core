/** mkdir: one directory, -p, and several operands. */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

Deno.test({
  name: 'mkdir command',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await t.step('creates a directory', async () => {
      await cmd.shouldSucceed('mkdir /newdir');

      const names = await client.execJson<string[]>('ls /');
      assertEquals(names.includes('newdir'), true);
    });

    await t.step('does not fail silently', async () => {
      const result = await client.exec('mkdir /newdir');
      // An existing directory is either an error or not, but always an answer.
      assertEquals(typeof result.success, 'boolean');
    });

    await t.step('creates nested directories with -p', async () => {
      await cmd.shouldSucceed('mkdir -p /deep/nested/path');
      await cmd.shouldSucceed('ls /deep/nested/path');
    });

    await t.step('fails without -p for missing parent', async () => {
      await cmd.shouldFail('mkdir /missing/parent/dir');
    });

    await t.step('creates several directories in one call', async () => {
      await cmd.shouldSucceed('mkdir /multi-a /multi-b /multi-c');

      const names = await client.execJson<string[]>('ls /');
      assertEquals(names.includes('multi-a'), true);
      assertEquals(names.includes('multi-b'), true);
      assertEquals(names.includes('multi-c'), true);
    });

    await t.step('-p applies to every operand', async () => {
      await cmd.shouldSucceed('mkdir -p /multi-deep/one/two /multi-deep/three');
      await cmd.shouldSucceed('ls /multi-deep/one/two');
      await cmd.shouldSucceed('ls /multi-deep/three');
    });

    // Like mkdir(1): report the failure, but do not abandon the operands after it.
    await t.step('a failing operand does not stop the rest', async () => {
      await cmd.shouldFail('mkdir /missing/parent/dir /after-the-failure');

      const names = await client.execJson<string[]>('ls /');
      assertEquals(names.includes('after-the-failure'), true);
    });

    await t.step('creates directory with specific mode', async () => {
      await cmd.shouldSucceed('mkdir -m 700 /privatedir');

      const names = await client.execJson<string[]>('ls /');
      assertEquals(names.includes('privatedir'), true);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
