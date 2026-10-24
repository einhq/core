/**
 * `$$` and `$BASHPID`: the shell's own name, `tty-…`, as a job's pid is `bg-…`.
 * bash-executor gives each subshell a BASHPID of its own.
 */

import { assertEquals, assertMatch, assertNotEquals } from '@std/assert';
import { createTestContext, type ShellClient } from '../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });
let client: ShellClient;

Deno.test({
  name: 'shell pid',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();

  try {
    await t.step('$$ is the shell, and so is BASHPID outside a subshell', async () => {
      const [pid, bashpid, tty] = (await client.execString('echo "$$"; echo "$BASHPID"; echo "$TTY_NAME"')).trim().split('\n');

      assertMatch(pid, /^tty-/);
      assertEquals(bashpid, pid);
      assertEquals(tty, pid);
    });

    await t.step('a subshell has a BASHPID of its own, and the same $$', async () => {
      const [pid, inner, innerPid] = (await client.execString('echo "$$"; echo "$(echo $BASHPID)"; echo "$(echo $$)"')).trim().split('\n');

      assertNotEquals(inner, pid);
      assertEquals(innerPid, pid);
    });
    await t.step("a command's environment has no $$, BASHPID or LINENO, but a variable set before it", async () => {
      const out = (await client.execString('X_TEST=1 env | grep -E "^(\\$|BASHPID|LINENO|RANDOM|X_TEST)=" | sort')).trim();

      assertEquals(out, 'X_TEST=1');
    });
  } finally {
    await testCtx.teardown();
  }
});
