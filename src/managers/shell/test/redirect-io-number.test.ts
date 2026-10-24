/**
 * A digits-only argument in front of a redirect, through the real shell.
 *
 * POSIX only calls a run of digits an IO_NUMBER when nothing separates it from
 * the `<`/`>` — `2>file` is fd 2, `seq 2 >file` passes 2 to seq, and
 * `tail -n 20 > /f` keeps its 20. The end-to-end check, since EiN is where the
 * linked parser and executor run together.
 */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient } from '../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });
let client: ShellClient;

Deno.test({
  name: 'digits before a redirect',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();

  try {
    await t.step('a separated number stays an argument', async () => {
      await client.exec('mkfile /f');
      const result = await client.exec('seq 3 > /f');
      assertEquals(result.success, true, `seq 3 > /f failed: ${result.error}`);
      assertEquals((await client.execString('cat /f')).trim().split('\n'), ['1', '2', '3']);
    });

    await t.step('a flag value before a redirect survives', async () => {
      await client.exec('mkfile /g');
      await client.exec('seq 30 > /g');
      await client.exec('mkfile /h');
      await client.exec('tail -n 2 /g > /h');
      assertEquals((await client.execString('cat /h')).trim().split('\n'), ['29', '30']);
    });

    await t.step('an adjacent number is still a file descriptor', async () => {
      // 2> must keep redirecting stderr, which is the case the adjacency rule
      // exists to preserve.
      await client.exec('mkfile /err');
      const result = await client.exec('nosuchcommand 2> /err');
      assertEquals(result.success, false);
      const captured = await client.execString('cat /err');
      assertEquals(captured.length > 0, true, 'stderr was not redirected into /err');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
