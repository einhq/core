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
  await harness.start();
  try {
    const result = await harness.runSSH('echo to-out; echo to-err >&2; nosuchcommand');
    assertEquals(result.stdout, 'to-out\n');
    assertEquals(result.stderr.split('\n')[0], 'to-err');
    assertEquals(result.stderr.includes('nosuchcommand'), true);
  } finally {
    await harness.stop();
  }
});

Deno.test({
  name: 'ssh server: exec output past the client window arrives whole, then stderr and the exit status',
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  await harness.start();
  try {
    // 6,888,896 bytes, more than three times the 2 MiB window an SSH client opens with
    const result = await harness.runSSH('seq 1 1000000; echo done >&2; exit 3');
    assertEquals(result.stdout.length, 6_888_896);
    assertEquals(result.stdout.slice(-15), '999999\n1000000\n');
    assertEquals(result.stderr, 'done\n');
    assertEquals(result.code, 3);
  } finally {
    await harness.stop();
  }
});
