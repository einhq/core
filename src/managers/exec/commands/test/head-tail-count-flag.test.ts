/**
 * The obsolescent `-NUM` count form on head/tail.
 *
 * `@std/cli` reads `-5` as a short option named `5` and `-12` as the cluster
 * `-1 -2`, taking the next operand as its value; `expandCountFlag` turns them
 * into a count, so `head -5 /f` reads five lines of the file.
 */

import { assertEquals } from '@std/assert';
import { expandCountFlag } from '../../../../lib/args/mod.ts';
import { createTestContext, type ShellClient } from '../../../../testing/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

Deno.test('expandCountFlag rewrites only a bare digit run', () => {
  assertEquals(expandCountFlag(['-5']), ['-n', '5']);
  assertEquals(expandCountFlag(['-12', '/f']), ['-n', '12', '/f']);
  assertEquals(expandCountFlag(['-c', '5']), ['-c', '5']);
  assertEquals(expandCountFlag(['-n', '5']), ['-n', '5']);
  // Not counts: a fraction, a tail start-offset, a plain operand.
  assertEquals(expandCountFlag(['-5.5']), ['-5.5']);
  assertEquals(expandCountFlag(['+5']), ['+5']);
  assertEquals(expandCountFlag(['--', '-5']), ['--', '-5']);
  // A different option letter, for a command whose count is not -n.
  assertEquals(expandCountFlag(['-3'], 'c'), ['-c', '3']);
});

Deno.test({
  name: 'head/tail -NUM',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();

  try {
    await t.step('head -NUM sets the line count', async () => {
      assertEquals((await client.execString('seq 20 | head -3')).trim().split('\n'), ['1', '2', '3']);
      // Two digits are one count, not the cluster -1 -2.
      assertEquals((await client.execString('seq 20 | head -12')).trim().split('\n').length, 12);
    });

    await t.step('tail -NUM sets the line count', async () => {
      assertEquals((await client.execString('seq 20 | tail -3')).trim().split('\n'), ['18', '19', '20']);
    });

    await t.step('-NUM keeps the path operand', async () => {
      await client.exec('mkfile /f');
      await client.exec('seq 20 > /f');

      assertEquals((await client.execString('head -2 /f')).trim().split('\n'), ['1', '2']);
      assertEquals((await client.execString('tail -2 /f')).trim().split('\n'), ['19', '20']);
    });

    await t.step('-n and the default are unchanged', async () => {
      assertEquals((await client.execString('seq 20 | head -n 4')).trim().split('\n').length, 4);
      assertEquals((await client.execString('seq 20 | head')).trim().split('\n').length, 10);
      assertEquals((await client.execString('seq 20 | tail')).trim().split('\n').length, 10);
    });

    await t.step('tail +NUM still starts at a line', async () => {
      assertEquals((await client.execString('seq 20 | tail -n +18')).trim().split('\n'), ['18', '19', '20']);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
