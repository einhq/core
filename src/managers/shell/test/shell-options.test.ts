/**
 * `set -e`, `-u` and `-x` through the real shell, with EiN's own commands rather
 * than test mocks, and with the two things that only matter here: the API shell
 * reports the abort as a failed command, and an aborted script does not take the
 * session down with it.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import { createTestContext, type ShellClient } from '../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });
let client: ShellClient;

Deno.test({
  name: 'shell options',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();

  try {
    await t.step('errexit stops a script at the failing command', async () => {
      const result = await client.exec('set -e; ls /nonexistent 2>/dev/null; echo after');

      assertEquals(result.success, false);
      // ls exits 2 for a path it cannot access, and errexit passes it on
      assertStringIncludes(result.error ?? '', 'code 2');
    });

    await t.step('without it the script carries on', async () => {
      const out = await client.execString('ls /nonexistent 2>/dev/null; echo after');

      assertEquals(out.trim(), 'after');
    });

    await t.step('a failure the script is testing for is exempt', async () => {
      const out = await client.execString('set -e; if ls /nonexistent 2>/dev/null; then echo found; else echo missing; fi; echo after');

      assertEquals(out.trim().split('\n'), ['missing', 'after']);
    });

    await t.step('an aborted script leaves the shell usable', async () => {
      await client.exec('set -e; ls /nonexistent 2>/dev/null; echo after');

      assertEquals((await client.execString('echo still-here')).trim(), 'still-here');
    });

    await t.step('nounset makes an unset variable an error', async () => {
      const result = await client.exec('set -u; echo "[${NOPE}]"; echo after');

      assertEquals(result.success, false);
      assertStringIncludes(result.error ?? '', 'NOPE: unbound variable');
    });

    await t.step('a variable that is set expands as usual', async () => {
      const out = await client.execString('set -u; V=1; echo "[$V]"; echo after');

      assertEquals(out.trim().split('\n'), ['[1]', 'after']);
    });

    await t.step("xtrace writes what runs to the shell's stderr", async () => {
      // `exec 2>&1` because the trace goes to the shell's stderr, not the
      // command's — `echo hi 2>/dev/null` still traces, as in bash
      const out = await client.execString('exec 2>&1; set -x; V=hi; echo "$V"');

      assertEquals(out, '+ V=hi\n+ echo hi\nhi\n');
    });

    await t.step('set -o and set +o list the options as bash does', async () => {
      // -o a name/state table, +o the commands that restore the state
      const table = await client.execString('set -o | grep -E "^(errexit|nounset) "');
      const commands = await client.execString('set +o | grep -E " (errexit|nounset)$"');

      assertEquals(table.trim().split('\n'), ['errexit        \toff', 'nounset        \toff']);
      assertEquals(commands.trim().split('\n'), ['set +o errexit', 'set +o nounset']);
    });

    await t.step('options do not leak between two shells', async () => {
      const other = await testCtx.server.createShellClient();

      try {
        await other.exec('set -e');

        assertEquals((await client.execString('ls /nonexistent 2>/dev/null; echo after')).trim(), 'after');
      } finally {
        await other.close();
      }
    });
  } finally {
    await client.close();
    await testCtx.teardown();
  }
});
