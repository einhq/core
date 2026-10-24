/** rmdir: an empty directory, a refused non-empty one, a refused non-directory, and -p. */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

Deno.test({
  name: 'rmdir command',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const names = (dir: string) => client.execJson<string[]>(`ls ${dir}`);

  try {
    await t.step('removes an empty directory', async () => {
      await client.exec('mkdir /rd-empty');
      await cmd.shouldSucceed('rmdir /rd-empty');
      assertEquals((await names('/')).includes('rd-empty'), false);
    });

    await t.step('refuses a non-empty directory', async () => {
      await client.exec('mkdir -p /rd-full/child');
      await cmd.shouldFailWith('rmdir /rd-full', 'Directory not empty');
      assertEquals(await names('/rd-full'), ['child']);
    });

    await t.step('refuses a file, even an empty one', async () => {
      await client.exec('mkfile /rd-file');
      await cmd.shouldFailWith('rmdir /rd-file', 'Not a directory');
      assertEquals((await names('/')).includes('rd-file'), true);
    });

    await t.step('refuses a link to an empty directory', async () => {
      await client.exec('mkdir /rd-target && ln -s /rd-target /rd-link');
      await cmd.shouldFailWith('rmdir /rd-link', 'Not a directory');
      const root = await names('/');
      assertEquals([root.includes('rd-link'), root.includes('rd-target')], [true, true]);
    });

    await t.step('fails for a missing path', async () => {
      await cmd.shouldFail('rmdir /rd-missing');
    });

    await t.step('goes on to the next operand after a failure', async () => {
      await client.exec('mkdir -p /rd-next/full/child /rd-next/empty');
      await cmd.shouldFail('rmdir /rd-next/full /rd-next/empty');
      assertEquals(await names('/rd-next'), ['full']);
    });

    await t.step('-p removes each parent the path names', async () => {
      await client.exec('mkdir -p /rd-p/a/b/c');
      await cmd.shouldSucceed('cd /rd-p && rmdir -p a/b/c');
      assertEquals(await names('/rd-p'), []);
    });

    await t.step('-p stops at the first parent that is not empty', async () => {
      await client.exec('mkdir -p /rd-stop/a/b/c /rd-stop/a/keep');
      await cmd.shouldFailWith('rmdir -p /rd-stop/a/b/c', "failed to remove '/rd-stop/a'");
      assertEquals(await names('/rd-stop/a'), ['keep']);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
