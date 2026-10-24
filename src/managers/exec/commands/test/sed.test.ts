/**
 * sed command: substitution (s///), print (p) and delete (d) with addressing,
 * driven through real shell pipelines.
 */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

Deno.test({
  name: 'sed command',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await t.step('substitutes first match on each line', async () => {
      assertEquals(
        (await client.execString("seq 5 | sed 's/3/X/'")).trim().split('\n'),
        ['1', '2', 'X', '4', '5'],
      );
    });

    await t.step('first vs global', async () => {
      assertEquals((await client.execString("printf 'a a a\\n' | sed 's/a/b/'")).trim(), 'b a a');
      assertEquals((await client.execString("printf 'a a a\\n' | sed 's/a/b/g'")).trim(), 'b b b');
    });

    await t.step('Nth occurrence', async () => {
      assertEquals((await client.execString("printf 'a a a\\n' | sed 's/a/X/2'")).trim(), 'a X a');
    });

    await t.step('backreferences and whole-match &', async () => {
      // Single quotes are literal (like bash), so \2\1 reaches sed verbatim.
      assertEquals(
        (await client.execString(String.raw`printf 'wo\n' | sed -E 's/(w)(o)/\2\1/'`)).trim(),
        'ow',
      );
      assertEquals((await client.execString("printf 'x\\n' | sed 's/x/[&]/'")).trim(), '[x]');
    });

    await t.step('alternate delimiter', async () => {
      assertEquals(
        (await client.execString("printf '/usr/bin\\n' | sed 's|/usr|/opt|'")).trim(),
        '/opt/bin',
      );
    });

    await t.step('-n with /regex/p is grep-like', async () => {
      assertEquals(
        (await client.execString("seq 5 | sed -n '/[24]/p'")).trim().split('\n'),
        ['2', '4'],
      );
    });

    await t.step('delete by line-number range', async () => {
      assertEquals((await client.execString("seq 5 | sed '2,4d'")).trim().split('\n'), ['1', '5']);
    });

    await t.step('delete last line with $', async () => {
      assertEquals(
        (await client.execString("seq 5 | sed '$d'")).trim().split('\n'),
        ['1', '2', '3', '4'],
      );
    });

    await t.step('negated address keeps only matching lines', async () => {
      assertEquals((await client.execString("seq 5 | sed '/3/!d'")).trim(), '3');
    });

    await t.step('multiple commands separated by ;', async () => {
      assertEquals(
        (await client.execString("printf '# c\\nkeep \\n' | sed '/#/d; s/ *$//'")).trim(),
        'keep',
      );
    });

    await t.step('reads from a FILE argument', async () => {
      await client.exec('mkfile /sedf');
      await client.exec('echo -e "a\\nb\\nc" > /sedf');
      assertEquals((await client.execString("sed -n '2p' /sedf")).trim(), 'b');
    });

    await t.step('no script fails', async () => {
      await cmd.shouldFail('sed');
    });

    await t.step('malformed s command fails', async () => {
      await cmd.shouldFail("sed 's/a'");
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
