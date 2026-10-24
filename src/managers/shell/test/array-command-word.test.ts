/**
 * A command word that expands to several words, as `"$@"` and `"${arr[@]}"` do: the first word is
 * the command and the rest are its arguments, as in bash, whether the command is a bin, a function
 * or comes after assignments.
 */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient } from '../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });
let client: ShellClient;

Deno.test({
  name: 'array expansion as the command word',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();

  try {
    const run = async (script: string) => (await client.execString(`export JSON_OUTPUT=0\n${script}`)).trim();

    await t.step('"$@" runs the positional parameters', async () => {
      assertEquals(await run(`set -- echo top a; "$@"; echo "rc=$?"`), 'top a\nrc=0');
    });

    await t.step('"${arr[@]}" runs the array', async () => {
      assertEquals(await run(`arr=(echo arr c); "\${arr[@]}" d`), 'arr c d');
    });

    await t.step('"$@" in a function runs its arguments', async () => {
      assertEquals(await run(`f() { "$@"; }; f echo x`), 'x');
    });

    await t.step('"$@" after an assignment runs with it in the environment', async () => {
      assertEquals(await run(`g() { echo "x=$X"; }; t() { X=1 "$@"; }; t g`), 'x=1');
    });

    await t.step('"$@" with no parameters runs nothing and succeeds', async () => {
      assertEquals(await run(`set --; "$@"; echo "rc=$?"`), 'rc=0');
    });
  } finally {
    await testCtx.teardown();
  }
});
