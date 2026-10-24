/**
 * fold command: wrapping to a width, at blanks with -s, and one character per line with -w1.
 */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';
import { foldLine } from '../utils/fold.ts';

Deno.test('foldLine', () => {
  assertEquals(foldLine('abcdefg', 3, false, false), ['abc', 'def', 'g']);
  assertEquals(foldLine('the quick brown fox', 10, true, false), ['the quick ', 'brown fox']);
  assertEquals(foldLine('abcdefghij', 4, true, false), ['abcd', 'efgh', 'ij']);
  // A tab moves to the next multiple of 8 unless -b counts it as one.
  assertEquals(foldLine('a\tb', 8, false, false), ['a\t', 'b']);
  assertEquals(foldLine('a\tb', 8, false, true), ['a\tb']);
  assertEquals(foldLine('', 5, false, false), ['']);
});

const testCtx = createTestContext();
let client: ShellClient;

Deno.test({
  name: 'fold command',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const run = async (line: string) => await client.execString(line, { json: false });

  try {
    await t.step('one character per line, then counted', async () => {
      assertEquals(await run(`echo 'abca' | fold -w1`), 'a\nb\nc\na\n');
      assertEquals(await run(`echo 'hello' | fold -w1 | sort | uniq -c`), '      1 e\n      1 h\n      2 l\n      1 o\n');
    });

    await t.step('width spellings: -w N, -wN, --width=N, -N', async () => {
      for (const flag of ['-w 3', '-w3', '--width=3', '-3']) {
        assertEquals(await run(`echo 'abcdefg' | fold ${flag}`), 'abc\ndef\ng\n', flag);
      }
    });

    await t.step('-s breaks at blanks; the default width is 80', async () => {
      assertEquals(await run(`echo 'the quick brown fox' | fold -s -w 10`), 'the quick \nbrown fox\n');
      assertEquals(await run(`seq -s x 50 | fold | wc -l`), '2\n');
    });

    await t.step('a last line without a newline stays without one', async () => {
      assertEquals(await run(`printf 'abcd' | fold -w2`), 'ab\ncd');
    });

    await t.step('files from the VFS', async () => {
      await run(`mkdir -p /tmp/fold-test && echo 'abcdef' > /tmp/fold-test/a.txt`);
      assertEquals(await run(`fold -w 4 /tmp/fold-test/a.txt`), 'abcd\nef\n');
    });

    await t.step('a bad width or option fails', async () => {
      const cmd = testCommands(client);
      await cmd.shouldFailWith(`echo x | fold -w 0`, 'invalid width');
      await cmd.shouldFailWith(`echo x | fold -z`, 'invalid option');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
