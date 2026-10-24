import { AbstractResourceHandle, RegistryIf, ResourceHandleIf, ResourceMode } from '../types.ts';
import { PoolIO, PoolJob, PoolJobId, PoolJobInput, PoolResourceOptions, PoolStat } from './types.ts';

/** Jobs fetched per page while streaming a snapshot. */
const PAGE = 100;

/**
 * Byte-stream view of a pool, so `cat` and shell redirection work on one.
 *
 * Reading is a **non-destructive** snapshot of the ready backlog: one JSON job
 * per read, then EOF. That is a deliberate departure from {@link QueueHandle},
 * where a read consumes the entry and `cat` therefore drains the queue — a pool
 * is something you inspect, and claiming is an explicit operation with a lease
 * and an owner, not a side effect of looking.
 *
 * Writing appends jobs as JSONL. There is no ack/nack protocol: a claim is not
 * expressed through the byte stream.
 */
export class PoolHandle extends AbstractResourceHandle<PoolResourceOptions, PoolStat> implements ResourceHandleIf<PoolResourceOptions, PoolStat> {
  private buffer: PoolJob[] = [];
  private cursor: PoolJobId = 0;
  private drained = false;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  constructor(
    id: string,
    options: PoolResourceOptions,
    mode: ResourceMode,
    registry: RegistryIf<PoolResourceOptions, PoolStat>,
    private io: PoolIO,
  ) {
    super(id, options, mode, registry, 1);
  }

  /** The claimable backlog, matching what `stat` reports as `size`. */
  override async size(): Promise<number> {
    const { size } = await this.registry.stat(this.id);
    return size;
  }

  /**
   * Next job of the snapshot, or empty at the end. The signal is accepted for
   * interface compatibility but unused: this read terminates on its own rather
   * than waiting for work to arrive.
   */
  async read(_size: number | bigint, _signal?: AbortSignal): Promise<Uint8Array> {
    this.assertNotClosed();
    this.assertCanRead();

    if (this.buffer.length === 0 && !this.drained) {
      this.buffer = await this.io.page(this.cursor, PAGE);

      if (this.buffer.length < PAGE) {
        this.drained = true;
      }

      if (this.buffer.length > 0) {
        this.cursor = this.buffer[this.buffer.length - 1].id;
      }
    }

    const job = this.buffer.shift();

    if (!job) {
      return new Uint8Array(0);
    }

    return this.encoder.encode(JSON.stringify(job) + '\n');
  }

  /** Append jobs, one `PoolJobInput` per line. */
  async write(data: Uint8Array): Promise<number> {
    this.assertNotClosed();
    this.assertCanWrite();

    const lines = this.decoder.decode(data).trim().split('\n').filter(Boolean);

    for (const line of lines) {
      await this.io.add(JSON.parse(line) as PoolJobInput);
    }

    return lines.length;
  }
}
