/**
 * SFTP backpressure: a client that sends many READs and never reads their
 * responses makes the session stop reading data for it, and stop taking its
 * requests, instead of holding every response.
 */

import { assert, assertEquals } from '@std/assert';
import { OPEN_MODE, type SFTP } from 'ssh2';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import { SFTPHandler } from '../sftp-handler.ts';

/** What the handler sees of ssh2's SFTP: requests come as events, responses are recorded. */
class ClientThatDoesNotRead {
  /** Bytes the client's window has not let out; nothing goes out until the test says so. */
  bufferedAmount = 0;
  dataSent = 0;
  opened?: Uint8Array;
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, fn: (...args: unknown[]) => void): void {
    this.listeners.set(event, [...this.listeners.get(event) ?? [], fn]);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const fn of this.listeners.get(event) ?? []) fn(...args);
  }

  handle(_reqid: number, handle: Uint8Array): void {
    this.opened = handle;
  }

  data(_reqid: number, data: Uint8Array): void {
    this.dataSent++;
    this.bufferedAmount += data.length;
  }

  status(): void {}

  /** The client read everything. */
  drain(): void {
    this.bufferedAmount = 0;
    this.emit('drain');
  }
}

const waitFor = async (what: string, ok: () => boolean) => {
  for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  assert(ok(), what);
};

Deno.test({
  name: 'SFTP holds a bounded amount for a client that does not read',
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const harness = new SystemTestHarness();
  const { vfs } = await harness.start();

  try {
    const size = 32 * 1024 * 1024;
    const { client, sftp: upload } = await harness.connectSFTP();
    await upload.writeFile('/home/admin/big.bin', new Uint8Array(size));
    client.end();

    const handler = new SFTPHandler({ vfs, access: ADMIN_ACCESS, homePath: '/home/admin' });
    const fake = new ClientThatDoesNotRead();
    handler.attach(fake as unknown as SFTP);

    fake.emit('OPEN', 1, '/home/admin/big.bin', OPEN_MODE.READ, {});
    await waitFor('the file opens', () => fake.opened !== undefined);

    // Far more READs than the session takes at once, each for a full packet.
    const length = 256 * 1024;
    const reads = size / length;
    for (let i = 0; i < reads; i++) fake.emit('READ', 2 + i, fake.opened, i * length, length);

    let ready = false;
    void handler.ready().then(() => ready = true);
    await waitFor('reads stop once 4 MiB is held', () => fake.dataSent > 0);
    await new Promise((r) => setTimeout(r, 200));
    assert(fake.bufferedAmount <= 4 * 1024 * 1024, `held ${fake.bufferedAmount}`);
    assert(fake.dataSent < reads);
    assertEquals(ready, false, 'the channel is not read while the requests wait');

    // As the client reads, the rest are answered and the session takes requests again.
    while (fake.dataSent < reads) {
      const sent = fake.dataSent;
      fake.drain();
      await waitFor('a drain lets more reads through', () => fake.dataSent > sent);
    }
    await waitFor('the session takes requests again', () => ready);
  } finally {
    await harness.stop();
  }
});
