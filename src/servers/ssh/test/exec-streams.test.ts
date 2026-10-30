/**
 * A command run over SSH without a terminal keeps its two output streams apart: what it writes
 * to stderr reaches the client as SSH's stderr, not mixed into stdout.
 */

import { assertEquals } from '@std/assert';
import { SystemTestHarness } from '../../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: true, boot: true });

Deno.test({
  name: 'ssh server: exec sends stderr on the stderr stream',
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  await harness.startPrimary();
  try {
    const result = await harness.runSSH('echo to-out; echo to-err >&2; nosuchcommand');
    assertEquals(result.stdout, 'to-out\n');
    assertEquals(result.stderr.split('\n')[0], 'to-err');
    assertEquals(result.stderr.includes('nosuchcommand'), true);
  } finally {
    await harness.stop();
  }
});
