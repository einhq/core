/**
 * A command run over SSH without a terminal reads its stdin as it was sent: no byte is taken as a
 * key, so a binary file piped in arrives whole and its end of input ends the command. With a pty
 * (`ssh -t`) a ^C interrupts it.
 */

import { assertEquals } from '@std/assert';
import { SystemTestHarness } from '../../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: true, boot: true });

Deno.test({
  name: 'ssh server: exec passes every byte of stdin through',
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  await harness.start();
  try {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const piped = await harness.runSSH('cat > /home/admin/bytes', { stdin: bytes });
    assertEquals(piped.code, 0);
    const { client, sftp } = await harness.connectSFTP();
    try {
      assertEquals(await sftp.readFile('/home/admin/bytes'), bytes);
    } finally {
      client.end();
    }
  } finally {
    await harness.stop();
  }
});

Deno.test({
  name: 'ssh server: exec with a pty takes ^C as an interrupt',
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  await harness.start();
  try {
    const client = await harness.connectSSH();
    try {
      const channel = await client.exec('sleep 30', { pty: true });
      const exited = new Promise<number>((resolve) => channel.on('exit-status', resolve));
      channel.readable.pipeTo(new WritableStream()).catch(() => {});
      // Once the command runs: a ^C typed before it starts has nothing to interrupt.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const writer = channel.writable.getWriter();
      await writer.write(new Uint8Array([3]));
      assertEquals(await exited, 130);
    } finally {
      client.end();
    }
  } finally {
    await harness.stop();
  }
});
