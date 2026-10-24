/**
 * What a background job writes reaches where its output goes, all of it, by
 * the time the job is done: the shell's output or the next stage of a pipeline.
 */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient } from '../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });
let client: ShellClient;

Deno.test({
  name: 'a background job',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();

  try {
    await t.step('has all it wrote passed on by the time wait returns', async () => {
      const out = await client.execString('seq 100000 & wait; echo end');
      const lines = out.trim().split('\n');

      assertEquals(lines.length, 100001);
      assertEquals(lines.at(-2), '100000');
    });

    await t.step('has the next stage of its pipeline read all it wrote', async () => {
      const out = await client.execString('{ seq 100000 & } | wc -l; echo "ps=${PIPESTATUS[@]}"');
      assertEquals(out.trim(), '100000\nps=0 0');
    });
  } finally {
    await client.close();
    await testCtx.teardown();
  }
});
