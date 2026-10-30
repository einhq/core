/**
 * A command that would ask a question on a terminal it does not have refuses at once, naming the
 * flag that answers it, rather than reading a stdin no one writes to: over an SSH exec channel,
 * whose stdin stays open. In an interactive shell it still asks, and reads the answer from a pipe.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import { InteractiveShell } from '../../../shell/interactive-shell.ts';
import { type ShellClient, SystemTestHarness } from '../../../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: true, boot: true });

/** A module directory of its own, so `mod remove` gets as far as its question. */
const MODULE = 'export MOD_PATH=/tmp/prompt-mods && mkdir -p /tmp/prompt-mods/demo && echo \'{"name":"demo","version":"0.1.0"}\' > /tmp/prompt-mods/demo/mod.json';

Deno.test({
  name: 'prompt: no terminal, no question',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const primary = await harness.startPrimary();
  let admin: ShellClient | undefined;

  try {
    admin = await harness.createShellClient();
    await admin.exec('user-create anna && user-passwd anna --new-password secret');

    await t.step('over SSH exec each prompting command refuses and names its flag', async () => {
      const result = await harness.runSSH(
        [
          MODULE,
          'mod remove demo; echo "code=$?"',
          'user-passwd anna; echo "code=$?"',
          'user-elevate; echo "code=$?"',
          'login anna; echo "code=$?"',
          '[ -e /tmp/prompt-mods/demo/mod.json ] && echo kept',
        ].join('\n'),
      );
      assertStringIncludes(result.stderr, 'mod-remove: no terminal to answer on; add --force');
      assertStringIncludes(result.stderr, 'user-passwd: no terminal to answer on; add --new-password');
      assertStringIncludes(result.stderr, 'user elevate: no terminal to answer on; add --password');
      assertStringIncludes(result.stderr, 'login: no terminal to answer on; give the password after the username');
      assertEquals(result.stdout.split('\n').filter((line) => line.startsWith('code=')), ['code=1', 'code=1', 'code=1', 'code=1']);
      assertStringIncludes(result.stdout, 'kept');
      assertEquals(result.code, 0);
    });

    await t.step('in an interactive shell the question is asked, and a pipe answers it', async () => {
      const { sessionPath } = await harness.createHttpSession();
      const shell = new InteractiveShell({ vfs: primary.vfs, cem: primary.cem, bufferManager: primary.bufferManager, sessionPath, origin: 'terminal' });
      await shell.open();
      try {
        // The module the step above kept
        assertEquals(await shell.run('export MOD_PATH=/tmp/prompt-mods'), 0);
        assertEquals(await shell.run('echo n | mod remove demo'), 0);
        assertEquals(await shell.run('[ -e /tmp/prompt-mods/demo/mod.json ]'), 0);
      } finally {
        await shell.close();
      }
    });
  } finally {
    admin?.close();
    await harness.stop();
  }
});
