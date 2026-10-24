import { Buffer } from 'node:buffer';
import type { Pool } from 'pg';
import { AbstractResourceHandle, modeFlags, type RegistryIf, type ResourceMode, type ResourceOptions, ResourceSeekMode } from '../types.ts';
import type { BlobStat, BlobStatX } from './types.ts';

// PostgreSQL large object mode flags
const INV_READ = 0x00040000;
const INV_WRITE = 0x00020000;

const STREAM_CHUNK_SIZE = 64 * 1024;

/**
 * PgBlobHandle - ResourceHandle backed by a PostgreSQL large object.
 *
 * Holds the object's OID and its own position, not a descriptor: every
 * operation is one statement in its own implicit transaction (`lo_get`,
 * `lo_put`, or an `lo_open` that the statement's end closes), so an open
 * handle holds no connection between calls and each write is committed when
 * it returns. Operations on one handle run one at a time, in call order.
 */
export class PgBlobHandle extends AbstractResourceHandle<ResourceOptions, BlobStat, BlobStatX> {
  private oid = 0;
  private offset = 0;
  private append: boolean;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    id: string,
    options: ResourceOptions,
    mode: ResourceMode,
    registry: RegistryIf<ResourceOptions, BlobStat, BlobStatX>,
    private pool: Pool,
    private lobTable: string,
  ) {
    super(id, options, mode, registry);
    this.append = modeFlags(mode).append;
  }

  /** Looks up the object, truncating it for `w`/`w+` and starting at its end for `a`/`a+`. */
  override async init(): Promise<void> {
    const row = await this.pool.query(
      `SELECT loid FROM ${this.lobTable} WHERE node_id = $1`,
      [this.id],
    );
    if (row.rows.length === 0) {
      throw new Error(`resource not found: ${this.id}`);
    }
    this.oid = row.rows[0].loid;

    if (modeFlags(this.mode).truncate) {
      await this.pool.query('SELECT lo_truncate64(lo_open($1, $2), 0)', [this.oid, INV_WRITE]);
    } else if (this.append) {
      this.offset = await this.end();
    }
  }

  /** Runs `op` after every operation queued before it. */
  private serial<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op);
    this.queue = next.catch(() => {});
    return next;
  }

  private async end(): Promise<number> {
    const result = await this.pool.query(
      'SELECT lo_lseek64(lo_open($1, $2), 0, 2) AS size',
      [this.oid, INV_READ],
    );
    return Number(result.rows[0].size);
  }

  private async readAt(size: number): Promise<Uint8Array> {
    const result = await this.pool.query(
      'SELECT lo_get($1, $2, $3) AS data',
      [this.oid, this.offset, size],
    );
    const chunk = result.rows[0].data as Buffer | null;
    if (!chunk || chunk.length === 0) return new Uint8Array(0);
    this.offset += chunk.length;
    return new Uint8Array(chunk);
  }

  private async writeAt(data: Uint8Array): Promise<number> {
    if (this.append) {
      // The end is found in the same statement as the write, as O_APPEND does
      const result = await this.pool.query(
        `WITH e AS (SELECT lo_lseek64(lo_open($1, $2), 0, 2) AS pos)
         SELECT pos, lo_put($1, pos, $3) FROM e`,
        [this.oid, INV_READ | INV_WRITE, Buffer.from(data)],
      );
      this.offset = Number(result.rows[0].pos);
    } else {
      await this.pool.query('SELECT lo_put($1, $2, $3)', [this.oid, this.offset, Buffer.from(data)]);
    }
    this.offset += data.length;
    return data.length;
  }

  override size(): Promise<number> {
    return this.serial(() => this.end());
  }

  override seek(offset: number, whence: ResourceSeekMode): Promise<number> {
    this.assertNotClosed();
    return this.serial(async () => {
      switch (whence) {
        case ResourceSeekMode.Start:
          return this.offset = offset;
        case ResourceSeekMode.Current:
          return this.offset += offset;
        case ResourceSeekMode.End:
          return this.offset = await this.end() + offset;
      }
    });
  }

  read(size: number, _signal?: AbortSignal): Promise<Uint8Array> {
    this.assertNotClosed();
    this.assertCanRead();
    return this.serial(() => this.readAt(size));
  }

  /** Writes at the current position, or at the end in append mode. */
  write(data: Uint8Array): Promise<number> {
    this.assertNotClosed();
    this.assertCanWrite();
    return this.serial(() => this.writeAt(data));
  }

  /** Waits for queued operations; each write is already committed. */
  override async sync(): Promise<void> {
    await this.serial(async () => {});
  }

  override async close(): Promise<void> {
    if (this._closed) return;
    await super.close();
    await this.sync();
  }

  override get readable(): ReadableStream<Uint8Array> {
    this.assertNotClosed();
    this.assertCanRead();

    return new ReadableStream({
      pull: async (controller) => {
        const chunk = await this.serial(() => this.readAt(STREAM_CHUNK_SIZE));
        if (chunk.length === 0) controller.close();
        else controller.enqueue(chunk as Uint8Array<ArrayBuffer>);
      },
    });
  }

  override get writable(): WritableStream<Uint8Array> {
    this.assertNotClosed();
    this.assertCanWrite();

    return new WritableStream({
      write: async (chunk) => {
        await this.serial(() => this.writeAt(chunk));
      },
    });
  }
}
