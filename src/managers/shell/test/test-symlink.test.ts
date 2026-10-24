/**
 * `test -L` and `test -h` ask about the path itself: a softlink is a link whether its target
 * exists or not, and neither its target nor a plain file is one.
 */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient } from '../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });
let client: ShellClient;

Deno.test({
  name: 'test -L and -h',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();

  try {
    const run = async (script: string) =>
      (await client.execString(
        `export JSON_OUTPUT=0\nd=/tmp/linktest\ncd $d 2>/dev/null || { mkdir -p $d && cd $d && echo x > target && ln -s $d/target live && ln -s $d/gone dangling; }\n${script}`,
      )).trim();
    const is = (op: string, path: string) => run(`[ ${op} ${path} ] && echo yes || echo no`);

    await t.step('a link to an existing node is a link', async () => {
      assertEquals(await is('-L', 'live'), 'yes');
      assertEquals(await is('-h', 'live'), 'yes');
    });

    await t.step('a dangling link is a link, and does not exist', async () => {
      assertEquals(await is('-L', 'dangling'), 'yes');
      assertEquals(await is('-e', 'dangling'), 'no');
    });

    await t.step('a plain file is not a link', async () => {
      assertEquals(await is('-L', 'target'), 'no');
    });
  } finally {
    await testCtx.teardown();
  }
});
