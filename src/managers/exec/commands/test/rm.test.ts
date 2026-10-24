/** rm: a file, a refused non-empty directory, -r and -f. */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

Deno.test({
  name: 'rm command',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await t.step('removes a file', async () => {
      await client.exec('mkfile /testfile');

      let names = await client.execJson<string[]>('ls /');
      assertEquals(names.includes('testfile'), true);

      await cmd.shouldSucceed('rm /testfile');

      names = await client.execJson<string[]>('ls /');
      assertEquals(names.includes('testfile'), false);
    });

    await t.step('removes an empty directory', async () => {
      await client.exec('mkdir /emptydir');
      await cmd.shouldSucceed('rm /emptydir');

      const names = await client.execJson<string[]>('ls /');
      assertEquals(names.includes('emptydir'), false);
    });

    await t.step('-d removes an empty directory and refuses a non-empty one', async () => {
      await client.exec('mkdir -p /emptyd /fulld/child');
      await cmd.shouldSucceed('rm -d /emptyd');
      await cmd.shouldFail('rm -d /fulld');

      const names = await client.execJson<string[]>('ls /');
      assertEquals([names.includes('emptyd'), names.includes('fulld')], [false, true]);
    });

    await t.step('fails on non-empty directory without -r', async () => {
      await client.exec('mkdir -p /nonempty1/child');
      await cmd.shouldFail('rm /nonempty1');
    });

    await t.step('removes non-empty directory with -r', async () => {
      await client.exec('mkdir -p /tree/a/b/c');
      await client.exec('mkfile /tree/a/one');
      await client.exec('mkfile /tree/a/b/c/two');

      await cmd.shouldSucceed('rm -r /tree');

      const names = await client.execJson<string[]>('ls /');
      assertEquals(names.includes('tree'), false);
    });

    await t.step('fails for non-existent path', async () => {
      await cmd.shouldFail('rm /nonexistent');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
