import { Deferred, deferred } from '../../lib/async/mod.ts';
import { AbstractResourceHandle, RegistryIf, ResourceHandleIf, ResourceMode } from '../types.ts';
import { QueueEntryId, QueueIO, QueueResourceOptions, QueueStat } from './types.ts';

export class QueueHandle extends AbstractResourceHandle<QueueResourceOptions, QueueStat> implements ResourceHandleIf<QueueResourceOptions, QueueStat> {
  private unAckedId: QueueEntryId | undefined = undefined;
  private ackGate: Deferred<void> | undefined = undefined;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  private autoAck: boolean;

  constructor(
    id: string,
    options: QueueResourceOptions,
    mode: ResourceMode,
    registry: RegistryIf<QueueResourceOptions, QueueStat>,
    private io: QueueIO,
  ) {
    super(id, options, mode, registry, 1);
    this.autoAck = !mode.includes('w') && !mode.includes('a') &&
      !mode.includes('+');
  }

  /** Return the number of claimable entries in the queue (in-flight ones excluded). */
  override async size(): Promise<number> {
    const { size } = await this.registry.stat(this.id);
    return size;
  }

  /** Read next entry; blocks if previous entry is unacked. Returns empty on abort/EOF. */
  async read(_size: number, signal?: AbortSignal): Promise<Uint8Array> {
    this.assertNotClosed();
    this.assertCanRead();

    // Block until previous entry is acked/nacked
    if (this.unAckedId !== undefined) {
      this.ackGate = deferred();
      await this.ackGate;

      if (this._closed) {
        return new Uint8Array(0);
      }
    }

    const entry = await this.io.read(signal);

    if (!entry) {
      return new Uint8Array(0);
    }

    // Closed while the read was in flight. `close()` has already run its
    // nack-the-in-flight-entry step, so stashing this one in `unAckedId` now
    // would leave it locked with nobody left to ack it.
    if (this._closed) {
      await this.io.nack(entry.id);
      return new Uint8Array(0);
    }

    if (this.autoAck) {
      await this.io.ack(entry.id);
    } else {
      this.unAckedId = entry.id;
    }

    return this.encoder.encode(JSON.stringify(entry.data) + '\n');
  }

  /** Write ack/nack responses or append new JSON entries to the queue. */
  async write(data: Uint8Array): Promise<number> {
    this.assertNotClosed();
    this.assertCanWrite();

    const text = this.decoder.decode(data).trim();
    const lines = text.split('\n').filter(Boolean);

    if (lines.length === 0) {
      return 0;
    }

    if (this.unAckedId !== undefined) {
      const result = lines.shift()!.toLowerCase();
      const id = this.unAckedId;

      if (result !== 'ack' && result !== 'nack') {
        throw Error(`expected 'ack' or 'nack'`);
      }

      // The entry stays the handle's until the backend has taken the answer:
      // when the ack or nack throws, a retried 'nack' still reaches this entry
      // instead of being parsed as an append.
      await (result === 'ack' ? this.io.ack(id) : this.io.nack(id));
      this.unAckedId = undefined;
      this.ackGate?.resolve();
      this.ackGate = undefined;
    }

    for (const line of lines) {
      await this.io.append(JSON.parse(line));
    }

    return lines.length;
  }

  /** Close the handle, nacking any unacknowledged entry and unblocking pending reads. */
  override async close(): Promise<void> {
    if (this._closed) {
      return;
    }

    // Unblock any pending read
    this.ackGate?.resolve();
    this.ackGate = undefined;

    if (this.unAckedId !== undefined) {
      const id = this.unAckedId;
      this.unAckedId = undefined;
      await this.io.nack(id);
    }

    await super.close();
  }
}
