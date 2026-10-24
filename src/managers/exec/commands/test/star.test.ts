/**
 * Star/bookmark tests: per-user softlinks in $HOME/stars.
 */

import { assertEquals } from '@std/assert';
import type { StarEntry } from '../../../../lib/api/mod.ts';
import { createTestContext, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });

Deno.test({
  name: 'stars',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await client.exec('mkdir -p /scratch && echo hi > /scratch/pic.txt');

    await t.step('star creates a softlink in $HOME/stars', async () => {
      await cmd.shouldSucceed('star /scratch/pic.txt');

      const list = await client.execJson<{ name: string; target: string }[]>('star list');
      assertEquals(list.length, 1);
      assertEquals(list[0].target, '/scratch/pic.txt');

      const out = await client.execString('ls /home/admin/stars');
      assertEquals(out.includes('pic.txt'), true, out);
    });

    await t.step('starring twice is a no-op', async () => {
      await cmd.shouldSucceed('star /scratch/pic.txt');
      const list = await client.execJson<{ name: string }[]>('star list');
      assertEquals(list.length, 1);
    });

    await t.step('star -d removes the star', async () => {
      await cmd.shouldSucceed('star -d /scratch/pic.txt');
      const list = await client.execJson<{ name: string }[]>('star list');
      assertEquals(list.length, 0);
    });

    await t.step('unstarring something not starred fails', async () => {
      await cmd.shouldFail('star -d /scratch/pic.txt');
    });

    await t.step('starring a missing node fails', async () => {
      await cmd.shouldFail('star /scratch/nope.txt');
    });

    await t.step('several paths star and unstar together', async () => {
      await client.exec('echo a > /scratch/a.txt && echo b > /scratch/b.txt');
      await cmd.shouldSucceed('star /scratch/a.txt /scratch/b.txt /scratch/pic.txt');
      const list = await client.execJson<StarEntry[]>('star list');
      assertEquals(list.map((entry) => entry.target).sort(), ['/scratch/a.txt', '/scratch/b.txt', '/scratch/pic.txt']);

      await cmd.shouldSucceed('star -d /scratch/a.txt /scratch/b.txt');
      assertEquals((await client.execJson<StarEntry[]>('star list')).map((entry) => entry.target), ['/scratch/pic.txt']);
    });

    await t.step('one path not starred stops the whole unstar', async () => {
      await cmd.shouldFail('star -d /scratch/pic.txt /scratch/a.txt');
      assertEquals((await client.execJson<StarEntry[]>('star list')).length, 1);
    });

    await t.step('one missing path stops the whole star', async () => {
      await cmd.shouldFail('star /scratch/a.txt /scratch/nope.txt');
      assertEquals((await client.execJson<StarEntry[]>('star list')).length, 1);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
