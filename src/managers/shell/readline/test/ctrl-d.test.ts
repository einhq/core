/**
 * Ctrl-D: end of input on an empty line, delete-char on a line with something
 * on it — as in bash.
 *
 * The empty-line case raises `EOT` rather than `EOF`, because the interactive
 * shell may decline to act on a keypress (`set -o ignoreeof`) while stdin going
 * away is never ignorable.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { BufferManager } from '../../../buffer/mod.ts';
import { Readline } from '../readline.ts';

const CTRL_D = '\x04';

Deno.test('Ctrl-D in readline', async (t) => {
  const bufferManager = new BufferManager();
  await bufferManager.init();
  const encoder = new TextEncoder();

  const readlineOn = async (id: string) => {
    await bufferManager.touch(`${id}-in`, {});
    await bufferManager.touch(`${id}-out`, {});

    const stdin = await bufferManager.open(`${id}-in`, {}, 'r+');
    const stdout = await bufferManager.open(`${id}-out`, {}, 'r+');

    return {
      stdin,
      rl: new Readline({ in: stdin, out: stdout, rows: 10, cols: 100 }),
    };
  };

  await t.step('on an empty line it is EOT', async () => {
    const { stdin, rl } = await readlineOn('empty');
    const prompt = rl.prompt('$');

    stdin.write(encoder.encode(CTRL_D));

    const error = await assertRejects(() => prompt);
    assertEquals((error as Error).message, 'EOT');
  });

  await t.step('on a line with text it deletes a character', async () => {
    const { stdin, rl } = await readlineOn('typed');
    const prompt = rl.prompt('$');

    stdin.write(encoder.encode('abc'));
    // Cursor to just after "a", then Ctrl-D twice: "abc" -> "ac" -> "a"
    stdin.write(encoder.encode('\x1b[D\x1b[D'));
    stdin.write(encoder.encode(CTRL_D));
    stdin.write(encoder.encode(CTRL_D));
    stdin.write(encoder.encode('\n'));

    assertEquals(await prompt, 'a');
  });
});
