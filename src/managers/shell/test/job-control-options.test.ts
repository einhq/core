/**
 * `set -o ignoreeof`, `set -b` and `set +m` in the interactive shell.
 *
 * These three are the shell's own, not the executor's — bash-executor records
 * them and can do nothing with them: a finished background job's line, and
 * whether Ctrl-D ends the session.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import { toText } from '@std/streams/to-text';
import { ulid } from '@std/ulid';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import { InteractiveShell } from '../interactive-shell.ts';
import type { ResourceHandleIf } from '../../../registries/types.ts';

const CTRL_D = '\x04';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

Deno.test({
  name: 'job control and eof options',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (t) => {
    const harness = new SystemTestHarness({ boot: true, ssh: false });
    const { vfs, cem, bufferManager } = await harness.startPrimary();

    const createShell = async () => {
      const { sessionPath } = await harness.createHttpSession();
      const shell = new InteractiveShell({ vfs, cem, bufferManager, sessionPath });

      await shell.open();

      const stdin = await shell.openIOHandle('rawStdin', 'w');
      const stderr = await shell.openIOHandle('stderr', 'r');
      const running = shell.runInteractive();

      const type = async (text: string) => {
        await stdin.write(encoder.encode(text));
        // Let the shell get through readline and any command it started
        await new Promise((resolve) => setTimeout(resolve, 150));
      };

      // Reads block until there is something, so the drain is bounded by a
      // signal rather than by hoping output has already arrived
      const readErr = async (handle: ResourceHandleIf = stderr): Promise<string> => {
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

      return { shell, running, type, readErr };
    };

    await t.step('ignoreeof refuses Ctrl-D and says how to leave', async () => {
      const { shell, running, type, readErr } = await createShell();

      await type('set -o ignoreeof\r');
      await readErr();

      await type(CTRL_D);
      assertStringIncludes(await readErr(), 'Use "exit" to leave the shell.');

      // Still running, and still usable
      assertEquals(shell.isClosed, false);

      await shell.close();
      await running;
    });

    await t.step('without it Ctrl-D ends the session', async () => {
      const { shell, running, type, readErr } = await createShell();

      await type(CTRL_D);
      assertStringIncludes(await readErr(), 'exit');
      assertEquals(await running, 0);

      await shell.close();
    });

    await t.step('a finished background job is reported at the next prompt', async () => {
      const { shell, running, type, readErr } = await createShell();

      await type('sleep 0.1 &\r');
      // The [1] <pid> line, which an interactive shell says, and nothing else yet
      const started = await readErr();

      assertStringIncludes(started, '[1] ');
      assertEquals(started.includes('Done'), false);

      // The report waits for a prompt, so it arrives with the next one
      await type('\r');
      assertStringIncludes(await readErr(), 'Done');

      await shell.close();
      await running;
    });

    await t.step('set -b reports it as it happens', async () => {
      const { shell, running, type, readErr } = await createShell();

      await type('set -b\r');
      await readErr();

      await type('sleep 0.1 &\r');
      // No new prompt in between: the line came out on its own
      assertStringIncludes(await readErr(), 'Done');

      await shell.close();
      await running;
    });

    await t.step('a failing job reports its status', async () => {
      const { shell, running, type, readErr } = await createShell();

      await type('set -b\r');
      await readErr();

      // ls exits 2 for a path it cannot access
      await type('ls /nonexistent 2>/dev/null &\r');
      assertStringIncludes(await readErr(), 'Exit 2');

      await shell.close();
      await running;
    });

    await t.step('set +m takes job control away, as it says on the tin', async () => {
      const { shell, running, type, readErr } = await createShell();

      await type('set +m\r');
      await readErr();

      await type('fg\r');
      assertStringIncludes(await readErr(), 'fg: no job control');

      await shell.close();
      await running;
    });

    const readFile = async (path: string): Promise<string> => {
      const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'r' });
      try {
        return await toText(handle.readable);
      } finally {
        await handle.close();
      }
    };

    await t.step('exit ends the session, and the EXIT trap runs with its status', async () => {
      const { shell, running, type, readErr } = await createShell();
      const path = `/tmp/exit-trap-${ulid()}`;

      await type(`trap 'echo "exit $?" > ${path}' EXIT\r`);
      await readErr();

      await type('exit 3\r');
      assertEquals(await running, 0);
      assertEquals(shell.hasExited, true);

      // The trap is the shell's end, which close() is
      await shell.close();
      assertEquals(await readFile(path), 'exit 3\n');
    });

    await t.step('a hang-up runs the HUP trap, then EXIT', async () => {
      const { shell, running, type, readErr } = await createShell();
      const path = `/tmp/hup-trap-${ulid()}`;

      await type(`trap 'echo hup >> ${path}' HUP; trap 'echo exit >> ${path}' EXIT\r`);
      await readErr();

      await shell.close();
      await running;
      assertEquals(await readFile(path), 'hup\nexit\n');
    });

    await t.step('a trap can still reach the jobs, before they are hung up', async () => {
      const { shell, running, type, readErr } = await createShell();
      const path = `/tmp/job-trap-${ulid()}`;

      await type(`sleep 30 & trap 'jobs > ${path}' EXIT\r`);
      await readErr();

      await shell.close();
      await running;
      assertStringIncludes(await readFile(path), 'Running');
    });

    await harness.stop();
  },
});
