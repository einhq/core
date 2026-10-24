/**
 * `set -o pipefail` and `PIPESTATUS`, through the real shell, with EiN's own
 * commands in the pipeline rather than test mocks.
 *
 * The option is per-shell state on the execution context: EiN runs every
 * session's shell in one process, and one session's option does not change
 * another session's exit codes.
 */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient } from '../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });
let client: ShellClient;

Deno.test({
  name: 'pipefail and PIPESTATUS',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();

  try {
    await t.step('without pipefail only the last stage counts', async () => {
      const out = await client.execString('ls /nonexistent 2>/dev/null | wc -l > /dev/null; echo "code=$?"');
      assertEquals(out.trim(), 'code=0');
    });

    await t.step('with pipefail a failing first stage fails the pipeline', async () => {
      // ls exits 2 for a path it cannot access, and it is the failing stage's own
      // status that pipefail hands back — not a flattened 1
      const out = await client.execString('set -o pipefail; ls /nonexistent 2>/dev/null | wc -l > /dev/null; echo "code=$?"');
      assertEquals(out.trim(), 'code=2');
    });

    await t.step('PIPESTATUS holds one status per stage', async () => {
      const out = await client.execString('ls /nonexistent 2>/dev/null | wc -l > /dev/null; echo "ps=${PIPESTATUS[@]}"');
      assertEquals(out.trim(), 'ps=2 0');
    });

    await t.step("a second shell does not see the first shell's option", async () => {
      const other = await testCtx.server.createShellClient();

      try {
        await other.exec('set -o pipefail');

        const out = await client.execString('set +o pipefail; ls /nonexistent 2>/dev/null | wc -l > /dev/null; echo "code=$?"');
        assertEquals(out.trim(), 'code=0');
      } finally {
        await other.close();
      }
    });
  } finally {
    await client.close();
    await testCtx.teardown();
  }
});
