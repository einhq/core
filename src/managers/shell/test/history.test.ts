/**
 * Shell history is the executor's, kept as bash keeps it, and stored as bash
 * stores it: in HISTFILE, `~/.bash_history`, a plain file the executor reads
 * as the shell starts (cut to HISTFILESIZE first) and adds each command to as
 * it runs.
 */

import { assertEquals } from '@std/assert';
import { join } from '@std/path';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import { NODE_TYPE_FILE } from '../../../vfs/types/file.ts';
import { InteractiveShell } from '../interactive-shell.ts';

/** Reachable only from a subclass — `runInput`, `historyLines` and `ctx` are protected. */
class ProbeShell extends InteractiveShell {
  /** As if typed at the prompt and Return pressed */
  async enter(line: string): Promise<void> {
    await this.runInput(line);
  }

  get lines(): string[] {
    return this.historyLines;
  }
}

Deno.test({
  name: 'shell history is kept in ~/.bash_history',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (t) => {
    const harness = new SystemTestHarness({ boot: true, ssh: false });
    const { vfs, cem, bufferManager } = await harness.startPrimary();

    const { sessionPath } = await harness.createHttpSession();
    const shell = new ProbeShell({ vfs, cem, bufferManager, sessionPath });
    await shell.open();

    const home = shell.getEnv().HOME;
    const historyPath = join(home, '.bash_history');

    const fileLines = async (): Promise<string[]> => {
      const handle = await vfs.open(ADMIN_ACCESS, historyPath, { mode: 'r' });
      try {
        const decoder = new TextDecoder();
        let content = '';
        while (true) {
          const chunk = await handle.read(1000);
          if (chunk.length === 0) break;
          content += decoder.decode(chunk, { stream: true });
        }
        content += decoder.decode();
        return content.split('\n').filter(Boolean);
      } finally {
        await handle.close();
      }
    };

    try {
      await t.step('HISTFILE is ~/.bash_history, and each command is added to it as it runs', async () => {
        assertEquals((await shell.runAndCapture('echo $HISTFILE')).stdout, `${historyPath}\n`);

        await shell.enter(': one');
        await shell.enter(': two');

        assertEquals((await vfs.get(ADMIN_ACCESS, historyPath)).type, NODE_TYPE_FILE);
        assertEquals(await fileLines(), [': one', ': two']);
      });

      await t.step('!! and a command over several lines are kept as bash keeps them', async () => {
        await shell.enter(': again');
        await shell.enter('!!');
        await shell.enter('for x in a\ndo :\ndone');

        assertEquals(shell.lines.slice(-2), [': again', 'for x in a; do :; done']);
        assertEquals((await fileLines()).slice(-2), [': again', 'for x in a; do :; done']);
      });

      await t.step('duplicate and space-prefixed lines are skipped', async () => {
        const before = await fileLines();
        await shell.enter(': final');
        await shell.enter(': final');
        await shell.enter(' : hidden');
        assertEquals(await fileLines(), [...before, ': final']);
      });

      await t.step('a new shell reads it back, cut to the HISTFILESIZE its .bashrc sets', async () => {
        await shell.runAndCapture(`echo 'HISTFILESIZE=3 HISTSIZE=3' > ${join(home, '.bashrc')}`);

        const next = new ProbeShell({ vfs, cem, bufferManager, sessionPath });
        await next.open();
        try {
          assertEquals(next.lines, [': again', 'for x in a; do :; done', ': final']);
          assertEquals(await fileLines(), [': again', 'for x in a; do :; done', ': final']);
        } finally {
          await next.close();
          await shell.runAndCapture(`rm ${join(home, '.bashrc')}`);
        }
      });
    } finally {
      await shell.close();
      await harness.stop();
    }
  },
});
