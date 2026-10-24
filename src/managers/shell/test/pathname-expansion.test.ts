/**
 * Pathname expansion through the real shell, where bash-executor matches the
 * patterns and the VFS lists the directories (`Shell.readDirectory`).
 *
 * What a word quoted matches itself, an unquoted expansion's `*` globs, and
 * `**` goes down every level (globstar is on).
 */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient } from '../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });
let client: ShellClient;

Deno.test({
  name: 'pathname expansion',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();

  try {
    const run = async (script: string) =>
      (await client.execString(
        `export JSON_OUTPUT=0\nd=/tmp/globtest\ncd $d 2>/dev/null || { mkdir -p $d/sub/deep && cd $d && echo x > 'a*b' && echo x > ab && echo x > sub/one.jpg && echo x > sub/deep/two.jpg; }\n${script}`,
      )).trim();

    await t.step('a quoted * matches only itself', async () => {
      assertEquals(await run(`printf '<%s>' "a*"*`), '<a*b>');
    });

    await t.step("an unquoted expansion's * globs, a quoted one does not", async () => {
      assertEquals(await run(`p='a*'; printf '<%s>' $p "$p"`), '<a*b><ab><a*>');
    });

    await t.step('** goes down every level', async () => {
      assertEquals(await run(`printf '<%s>' **/*.jpg`), '<sub/deep/two.jpg><sub/one.jpg>');
    });

    await t.step('a directory named by a quoted variable is listed whatever it holds', async () => {
      assertEquals(await run(`x=sub; printf '<%s>' "$x"/*`), '<sub/deep><sub/one.jpg>');
    });
  } finally {
    await testCtx.teardown();
  }
});
