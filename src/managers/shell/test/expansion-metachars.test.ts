/**
 * Metacharacters that come out of an expansion, through the real shell.
 *
 * Redirections and operators are recognised when the input is tokenized, not again on
 * what an expansion produced — `A='x>y'; echo $A` prints `x>y`, and a `-resize 1600x1600>`
 * argument keeps its `>`. The end-to-end check, since EiN is where the linked parser and
 * executor run together.
 */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient } from '../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });
let client: ShellClient;

Deno.test({
  name: 'metacharacters from an expansion',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();

  try {
    const run = (script: string) => client.execString(`export JSON_OUTPUT=0\n${script}`);

    await t.step('a > in an unquoted expansion is a literal, not a redirection', async () => {
      const out = await run(`ARGS="-resize 1600x1600>"\necho $ARGS`);
      assertEquals(out.trim(), '-resize 1600x1600>');
    });

    await t.step('the other metacharacters survive too', async () => {
      const out = await run(`VAR="a|b&c;d(e)f<g>h"\necho $VAR`);
      assertEquals(out.trim(), 'a|b&c;d(e)f<g>h');
    });

    await t.step('word splitting on whitespace is unaffected', async () => {
      const out = await run(`VAR="a>b c>d"\nfor w in $VAR; do echo "[$w]"; done`);
      assertEquals(out.trim().split('\n').map((l) => l.trim()), ['[a>b]', '[c>d]']);
    });

    await t.step('a > written in the script is still a redirection', async () => {
      const out = await run(`echo hello > /tmp/metachar-probe\ncat /tmp/metachar-probe`);
      assertEquals(out.trim(), 'hello');
    });
  } finally {
    await testCtx.teardown();
  }
});
