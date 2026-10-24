/**
 * A pipeline stage that ends before it has read all of its input ends the
 * stage writing to it, as SIGPIPE does in bash: quietly, with 141. EiN's own
 * commands and the shell's builtins alike, through the real shell.
 */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient } from '../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });
let client: ShellClient;

Deno.test({
  name: 'a write to an ended pipeline stage',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();

  try {
    await t.step('ends a command that writes more than the pipe holds, with 141', async () => {
      const out = await client.execString('seq 100000 | true; echo "ps=${PIPESTATUS[@]}"');
      assertEquals(out.trim(), 'ps=141 0');
    });

    await t.step('says nothing about it', async () => {
      const out = await client.execString('{ seq 100000 | true; seq 100000 2>&1 | true; } 2>&1; echo end');
      assertEquals(out.trim(), 'end');
    });

    await t.step('ends a builtin loop', async () => {
      const out = await client.execString('while :; do echo y; done | true; echo "ps=${PIPESTATUS[@]}"');
      assertEquals(out.trim(), 'ps=141 0');
    });

    await t.step('lets head end as soon as it has its lines', async () => {
      const out = await client.execString('while :; do echo y; done | head -n2; echo "ps=${PIPESTATUS[@]}"');
      assertEquals(out.trim(), 'y\ny\nps=141 0');
    });

    await t.step('lets grep -q end at its first match', async () => {
      const out = await client.execString('seq 1000000 | grep -q 5; echo "ps=${PIPESTATUS[@]}"');
      assertEquals(out.trim(), 'ps=141 0');
    });

    await t.step('ends a script run as a command, not the shell that ran it', async () => {
      const out = await client.execString(
        'mkdir -p ~/bin-572 >/dev/null && printf "while :; do echo y; done\\necho not-reached >&2\\n" > ~/bin-572/yes-572 && ' +
          'chmod +x ~/bin-572/yes-572 >/dev/null && { ~/bin-572/yes-572 | true; } 2>&1; echo "ps=${PIPESTATUS[@]}"',
      );
      assertEquals(out.trim(), 'ps=141 0');
    });

    await t.step('leaves the writer alone while a job the reading stage started still reads', async () => {
      const out = await client.execString('seq 100000 | { wc -l >/dev/null & }; echo "ps=${PIPESTATUS[@]}"');
      assertEquals(out.trim(), 'ps=0 0');
    });

    await t.step('leaves a stage that read everything its own status', async () => {
      const out = await client.execString('seq 3 | wc -l; echo "ps=${PIPESTATUS[@]}"');
      assertEquals(out.trim(), '3\nps=0 0');
    });
  } finally {
    await client.close();
    await testCtx.teardown();
  }
});
