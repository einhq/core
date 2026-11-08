/**
 * Ctrl-D while a command reads the terminal ends that command's input, as a terminal's VEOF does,
 * and the next command reads the terminal again. At the prompt it still ends the shell only on an
 * empty line.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import { SystemTestHarness } from '../../../testing/mod.ts';
import { InteractiveShell } from '../interactive-shell.ts';
import type { ResourceHandleIf } from '../../../registries/types.ts';

const CTRL_D = '\x04';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

Deno.test({
  name: 'Ctrl-D ends a command reading the terminal',
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
      // Let the shell get through readline and any command it started
      await new Promise((resolve) => setTimeout(resolve, 150));
    };

    // The terminal echoes typed text and draws prompts, so what a command wrote is looked for
    // between markers it is run with.
    const read = async (handle: ResourceHandleIf = stdout): Promise<string> => {
      let text = '';

      while (true) {
        try {
          const chunk = await handle.read(64 * 1024, AbortSignal.timeout(200));

          if (chunk.length === 0) {
            break;
          }

          text += decoder.decode(chunk);
        } catch {
          break;
        }
      }

      return text;
    };

    await type('cd /tmp\r');
    await read();

    await t.step('cat ends and the shell goes on', async () => {
      await type('cat; echo "<cat $?>"\r');
      await type('one\r');
      await type(CTRL_D);
      assertStringIncludes(await read(), '<cat 0>');
    });

    await t.step('cat > file keeps what was typed', async () => {
      await type('cat > notes.txt\r');
      await type('first\rsecond\r');
      await type(CTRL_D);
      await type('echo "<$(cat notes.txt | tr "\\n" ,)>"\r');
      assertStringIncludes(await read(), '<first,second,>');
    });

    await t.step('wc -l and sort read up to it', async () => {
      await type('wc -l | sed "s/^/<wc /;s/$/>/"\r');
      await type('b\ra\r');
      await type(CTRL_D);
      assertStringIncludes(await read(), '<wc 2>');

      await type('sort | tr "\\n" , | sed "s/^/<sort /;s/$/>/"\r');
      await type('b\ra\r');
      await type(CTRL_D);
      assertStringIncludes(await read(), '<sort a,b,>');
    });

    await t.step('head ends early on it', async () => {
      await type('head -n 5 | tr "\\n" , | sed "s/^/<head /;s/$/>/"\r');
      await type('x\r');
      await type(CTRL_D);
      assertStringIncludes(await read(), '<head x,>');
    });

    await t.step('read gets an unfinished line and fails, as in bash', async () => {
      await type('read v; echo "<read $? $v>"\r');
      await type('part');
      await type(CTRL_D);
      assertStringIncludes(await read(), '<read 1 part>');
    });

    await t.step('one Ctrl-D ends one command; the next reads the terminal again', async () => {
      await type('cat > a.txt; cat > b.txt; echo "<$(cat a.txt)|$(cat b.txt)>"\r');
      await type('A\r');
      await type(CTRL_D);
      await type('B\r');
      await type(CTRL_D);
      assertStringIncludes(await read(), '<A|B>');
    });

    await t.step('xargs -o: each command reading the terminal ends on its own Ctrl-D', async () => {
      await type('printf "5\\n5\\n" | xargs -o -n 1 head -n; echo "<xargs $?>"\r');
      await type('P\r');
      await type(CTRL_D);
      await type('Q\r');
      await type(CTRL_D);
      assertStringIncludes(await read(), 'P\nQ\n<xargs 0>');
    });

    await t.step('a Ctrl-D nothing read is dropped at the prompt', async () => {
      await type('sleep 0.3\r');
      await type(CTRL_D);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await read();
      assertEquals(shell.isClosed, false);

      await type('echo "<still>"\r');
      assertStringIncludes(await read(), '<still>');
    });

    await t.step('at the prompt Ctrl-D on an empty line ends the shell', async () => {
      await type(CTRL_D);
      assertEquals(await running, 0);
    });

    await shell.close();
  },
});
