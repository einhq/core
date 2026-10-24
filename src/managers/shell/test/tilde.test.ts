/**
 * Tilde prefixes in the EiN shell, as in bash: `~` is HOME as it is when the word runs, `~name`
 * the home of a user that exists, and anything else stays as written.
 */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient } from '../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });
let client: ShellClient;

Deno.test({
  name: 'tilde expansion',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();

  try {
    const run = async (script: string) => (await client.execString(`export JSON_OUTPUT=0\n${script}`)).trim();

    await t.step('~ is HOME as it is when the word runs', async () => {
      assertEquals(await run('echo ~; export HOME=/tmp; echo ~ ~/a x=~/a:~/b; f() { echo ~; }; f'), '/home/admin\n/tmp /tmp/a x=/tmp/a:/tmp/b\n/tmp');
    });

    await t.step('~name is the home of a user that exists, and stays as written otherwise', async () => {
      assertEquals(await run('echo ~admin/x ~nosuchuser ~.. "~" ~foo"bar"'), '/home/admin/x ~nosuchuser ~.. ~ ~foobar');
    });

    await t.step("with HOME unset, ~ is the home of the shell's user", async () => {
      assertEquals(await run('unset HOME; echo ~'), '/home/admin');
    });
  } finally {
    await testCtx.teardown();
  }
});
