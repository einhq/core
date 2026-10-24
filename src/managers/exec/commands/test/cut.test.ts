/**
 * cut: field and character selection, driven through real shell pipelines.
 *
 * The delimiter is the interesting part: `-d" "` attached to its option, as in
 * `grep "^size:" | cut -d" " -f2`, is a space delimiter, not an empty one.
 */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient } from '../../../../testing/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

Deno.test({
  name: 'cut command',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();

  try {
    await t.step('delimiter attached to -d', async () => {
      assertEquals((await client.execString(`printf 'size: 12345\\n' | cut -d" " -f2`)).trim(), '12345');
      assertEquals((await client.execString(`printf 'a:b:c\\n' | cut -d: -f2`)).trim(), 'b');
    });

    await t.step('delimiter as a separate argument', async () => {
      assertEquals((await client.execString(`printf 'a:b:c\\n' | cut -d ':' -f3`)).trim(), 'c');
    });

    await t.step('field ranges and lists', async () => {
      assertEquals((await client.execString(`printf 'a:b:c:d\\n' | cut -d: -f2-3`)).trim(), 'b:c');
      assertEquals((await client.execString(`printf 'a:b:c:d\\n' | cut -d: -f1,4`)).trim(), 'a:d');
    });

    await t.step('tab is the default delimiter', async () => {
      assertEquals((await client.execString(`printf 'a\\tb\\n' | cut -f2`)).trim(), 'b');
    });

    await t.step('character selection', async () => {
      assertEquals((await client.execString(`printf 'abcdef\\n' | cut -c2-4`)).trim(), 'bcd');
    });

    await t.step('a delimiter that is not one character is an error', async () => {
      const result = await client.exec(`printf 'a::b\\n' | cut -d'::' -f2`);
      assertEquals(result.success, false);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
