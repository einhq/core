/**
 * Ctrl-C at a line that runs no command, a loop of builtins and arithmetic, ends the line, as
 * bash's does; the shell keeps what the lines before it set, and the server goes on meanwhile.
 * Closing the shell ends such a line as well.
 */

import { assert, assertStringIncludes } from '@std/assert';
import { SystemTestHarness } from '../../../testing/mod.ts';
import { InteractiveShell } from '../interactive-shell.ts';

const CTRL_C = '\x03';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

Deno.test({
  name: 'Ctrl-C ends a line that runs no command',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (t) => {
    const harness = new SystemTestHarness({ boot: true, ssh: false });
    const { vfs, cem, bufferManager } = await harness.start();

    const { sessionPath } = await harness.createHttpSession();
    const shell = new InteractiveShell({ vfs, cem, bufferManager, sessionPath });
    await shell.open();

    const stdin = await shell.openIOHandle('rawStdin', 'w');
    const stdout = await shell.openIOHandle('stdout', 'r');
    const running = shell.runInteractive();

    const type = async (text: string) => {
      await stdin.write(encoder.encode(text));
      await new Promise((resolve) => setTimeout(resolve, 150));
    };

    // The terminal echoes typed text, so what a command wrote is looked for between markers
    const read = async (): Promise<string> => {
      let text = '';

      while (true) {
        try {
          const chunk = await stdout.read(64 * 1024, AbortSignal.timeout(200));
          if (chunk.length === 0) break;
          text += decoder.decode(chunk);
        } catch {
          break;
        }
      }

      return text;
    };

    await type('cd /tmp; kept=yes\r');
    await read();

    await t.step('an endless loop ends, and the rest of its line does not run', async () => {
      await type('while ((1)); do :; done; echo "<after $((1 + 1))>"\r');

      // The timer fires while the loop runs
      const started = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert(performance.now() - started < 1000, 'the event loop was held');

      await type(CTRL_C);
      await type('echo "<$? $kept $PWD>"\r');
      const output = await read();
      assertStringIncludes(output, '<130 yes /tmp>');
      assert(!output.includes('<after 2>'), output);
    });

    await t.step('a command running takes the Ctrl-C itself, and the line goes on', async () => {
      await type('sleep 30; echo "<after $((2 + 2))>"\r');
      await type(CTRL_C);
      assertStringIncludes(await read(), '<after 4>');
    });

    await t.step('closing the shell ends a line that loops', async () => {
      await type('while :; do :; done\r');
      await shell.close();
      const ended = await Promise.race([running.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5000))]);
      assert(ended, 'the line went on after the shell closed');
    });
  },
});
