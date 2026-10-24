/**
 * `top` in the UI's terminal panel: drawn on the alternate screen at the terminal's size, redrawn
 * when the size changes, answering keys, and giving the shell its screen back on `q`.
 */

import { assert } from '@std/assert';
import HeadlessXterm from '@xterm/headless';
import { InteractiveTerminalRegistry } from '../../../../../../servers/http/ws/interactive-terminal-registry.ts';
import { SystemTestHarness } from '../../../../../../testing/mod.ts';

async function waitFor(predicate: () => boolean, message: () => string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message());
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

Deno.test({
  name: 'top in the terminal panel',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const harness = new SystemTestHarness({ boot: true, ssh: false });
  const primary = await harness.startPrimary();
  const registry = new InteractiveTerminalRegistry({ vfs: primary.vfs, cem: primary.cem, bufferManager: primary.bufferManager, env: primary.shell.getEnv() }, 0);

  // The browser's side: what the terminal panel shows, from what the socket sends it.
  const screen = new HeadlessXterm.Terminal({ allowProposedApi: true, cols: 120, rows: 40, convertEol: true });
  const peer = {
    readyState: WebSocket.OPEN,
    send: (data: string) => {
      try {
        if (typeof JSON.parse(data)?.type === 'string') return;
      } catch {
        // Not a control message: output.
      }
      screen.write(data);
    },
    close: () => {},
  };
  const lines = () => Array.from({ length: screen.rows }, (_, i) => screen.buffer.active.getLine(i)?.translateToString(true) ?? '');
  const shown = () => lines().join('\n');

  const { sessionPath } = await harness.createHttpSession();
  const terminal = await registry.attach(sessionPath, 'top-tab', peer, { resumable: true });

  try {
    await t.step("draws the dashboard on the alternate screen at the terminal's size", async () => {
      await terminal.resize(40, 120);
      await terminal.write('top\r');
      await waitFor(() => screen.buffer.active.type === 'alternate' && shown().includes('─ Processes '), () => `no dashboard:\n${shown()}`);
      const frame = lines();
      assert(frame[0].startsWith(' EiN top '), frame[0]);
      assert(frame[39].startsWith(' q quit'), frame[39]);
      // Its own shell is on it twice: the session, and `top` among the processes.
      await waitFor(() => /terminal\/\S{4}/.test(shown()) && / top\s*│/.test(shown()), () => `no session or process:\n${shown()}`);
    });

    await t.step('answers keys', async () => {
      await terminal.write('s');
      await waitFor(() => shown().includes('sort: oldest'), () => `the sort did not change:\n${shown()}`);
      await terminal.write('p');
      await waitFor(() => shown().includes(' paused ') && shown().includes('p resume'), () => `did not pause:\n${shown()}`);
    });

    await t.step('redraws at a new size', async () => {
      screen.resize(80, 24);
      await terminal.resize(24, 80);
      await waitFor(() => lines()[23].startsWith(' q quit') && lines()[1].endsWith('╮') && lines()[1].length === 80, () => `not redrawn at 80x24:\n${shown()}`);
    });

    await t.step('gives the shell its screen back on q', async () => {
      await terminal.write('q');
      await waitFor(() => screen.buffer.active.type === 'normal', () => 'still on the alternate screen');
      await terminal.write('echo back at the prompt\r');
      await waitFor(() => shown().includes('back at the prompt\n') || /^back at the prompt$/m.test(shown()), () => `the shell did not come back:\n${shown()}`);
    });
  } finally {
    await terminal.terminate();
    await registry.dispose();
    screen.dispose();
    await harness.stop();
  }
});
