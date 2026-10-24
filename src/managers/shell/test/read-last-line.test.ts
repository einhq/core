/**
 * `read` and a last line with no newline: it is assigned, and read fails, as
 * bash's does — so `while read l` skips it and `while read l || [[ -n $l ]]`
 * is what keeps it. The shell's `pipeReadRecord` says which it was.
 */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient } from '../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });
let client: ShellClient;

Deno.test({
  name: 'read and a last line with no newline',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();

  try {
    await t.step('while read skips it, || [[ -n ]] keeps it', async () => {
      const out = await client.execString(`printf 'a\\nb' | while read l; do echo "[$l]"; done; printf 'a\\nb' | while read l || [[ -n $l ]]; do echo "<$l>"; done`);

      assertEquals(out.trim().split('\n'), ['[a]', '<a>', '<b>']);
    });

    await t.step('read assigns it and fails', async () => {
      const out = await client.execString(`printf 'x' | { read v; echo "$? $v"; }`);

      assertEquals(out.trim(), '1 x');
    });
  } finally {
    await testCtx.teardown();
  }
});
