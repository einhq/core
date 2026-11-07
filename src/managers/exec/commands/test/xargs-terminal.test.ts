/**
 * xargs at a terminal: -p asks on it before each run and reads the answer from it, not from the
 * items on stdin; -o gives each command the terminal as its stdin.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import { SystemTestHarness } from '../../../../testing/mod.ts';
import { InteractiveShell } from '../../../shell/interactive-shell.ts';
import type { ResourceHandleIf } from '../../../../registries/types.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Read `handle` until what was read includes `text`. */
const readUntil = async (handle: ResourceHandleIf, text: string): Promise<string> => {
  let read = '';
  while (!read.includes(text)) {
    const chunk = await handle.read(64 * 1024, AbortSignal.timeout(5000));
    if (chunk.length === 0) break;
    read += decoder.decode(chunk);
  }
  return read;
};

Deno.test({
  name: 'xargs at a terminal',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const harness = new SystemTestHarness({ boot: true, ssh: false });
  const { vfs, cem, bufferManager } = await harness.start();
  const { sessionPath } = await harness.createHttpSession();
  const shell = new InteractiveShell({ vfs, cem, bufferManager, sessionPath });
  await shell.open();
  const terminal = await shell.openIOHandle('rawStdin', 'w');
  const stdout = await shell.openIOHandle('stdout', 'r');
  const stderr = await shell.openIOHandle('stderr', 'r');
  const type = (text: string) => terminal.write(encoder.encode(text));

  try {
    await t.step('-p asks before each run, on stderr, and runs on a yes', async () => {
      const running = shell.run("printf 'a\\nb\\nc\\n' | xargs -p -n1 echo got");
      assertStringIncludes(await readUntil(stderr, 'echo got a ?...'), 'echo got a ?...');
      await type('y\r');
      assertStringIncludes(await readUntil(stderr, 'echo got b ?...'), 'echo got b ?...');
      await type('no\r');
      assertStringIncludes(await readUntil(stderr, 'echo got c ?...'), 'echo got c ?...');
      await type('Yes\r');
      assertEquals(await running, 0);
      assertEquals(await readUntil(stdout, 'got c\n'), 'got a\ngot c\n');
    });

    await t.step('-o gives each command the terminal as its stdin', async () => {
      await type('typed\r');
      assertEquals(await shell.run("printf 'x\\n' | xargs -o -I {} head -n1"), 0);
      assertStringIncludes(await readUntil(stdout, 'typed'), 'typed');
    });
  } finally {
    await shell.close();
    await harness.stop();
  }
});
