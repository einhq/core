/**
 * File content on an SFTP server, for an `sftp` mount. Resources are named by
 * their path within the mount (the store is path-addressed).
 *
 * A handle reads ahead and keeps several writes in flight, so streaming a file
 * is not one network round trip per chunk. `stat` gives no local `path`, so an
 * external tool is handed a staged copy.
 */

import { createSha256 } from '../../lib/hash/mod.ts';
import { getMimeFromBuffer, MIME_SAMPLE_BYTES } from '../../lib/media/mod.ts';
import { type SftpConnection, sftpReadable, sftpTimeMs } from '../../lib/ssh/mod.ts';
import { AbstractResourceHandle, ensureResource, RegistryIf, ResourceHandleIf, ResourceMode, ResourceOptions, ResourceSeekMode } from '../types.ts';
import { FileRegistryIf, FileStat, FileStatX } from './types.ts';

const NO_SUCH_FILE = 2;
const WRITES_IN_FLIGHT = 16;
const READ_AHEAD_CHUNK = 64 * 1024;

function isNotFound(error: unknown): boolean {
  return (error as { code?: number })?.code === NO_SUCH_FILE;
}

class SftpFileHandle extends AbstractResourceHandle<ResourceOptions, FileStat, FileStatX> implements ResourceHandleIf<ResourceOptions, FileStat, FileStatX> {
  private handle?: Uint8Array;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private leftover: Uint8Array = new Uint8Array(0);
  private pending = new Set<Promise<void>>();
  private failure: unknown;

  constructor(
    id: string,
    options: ResourceOptions,
    mode: ResourceMode,
    registry: RegistryIf<ResourceOptions, FileStat, FileStatX>,
    private conn: SftpConnection,
  ) {
    super(id, options, mode, registry);
  }

  override async init(): Promise<void> {
    const sftp = await this.conn.get();
    // ssh2 takes the same r/w/a/r+/w+/a+ strings as ResourceMode
    this.handle = await sftp.open(this.conn.remote(this.id), this.mode);
    this.conn.invalidate(this.id);
    if (this.mode.startsWith('a')) this._position = await this.size();
  }

  override assertNotClosed(): void {
    super.assertNotClosed();
    if (!this.handle) throw new Error('handle is not initialized');
  }

  /** Wait for writes in flight; rethrow the first that failed */
  private async settle(limit = 0): Promise<void> {
    while (this.pending.size > limit) await Promise.race(this.pending);
    if (this.failure) {
      const failure = this.failure;
      this.failure = undefined;
      throw failure;
    }
  }

  private async dropReader(): Promise<void> {
    const reader = this.reader;
    this.reader = undefined;
    this.leftover = new Uint8Array(0);
    await reader?.cancel().catch(() => {});
  }

  override async size(): Promise<number> {
    this.assertNotClosed();
    await this.settle();
    const sftp = await this.conn.get();
    return Number((await sftp.fstat(this.handle!)).size ?? 0);
  }

  override async seek(offset: number, whence: ResourceSeekMode): Promise<number> {
    this.assertNotClosed();
    const base = whence === ResourceSeekMode.Start ? 0 : whence === ResourceSeekMode.Current ? this._position : await this.size();
    const target = Math.max(0, base + offset);
    if (target !== this._position) await this.dropReader();
    this._position = target;
    return target;
  }

  /** Up to `size` bytes from the current position; empty at EOF */
  async read(size: number, _signal?: AbortSignal): Promise<Uint8Array> {
    this.assertNotClosed();
    this.assertCanRead();
    await this.settle();

    if (this.leftover.length === 0) {
      if (!this.reader) {
        const sftp = await this.conn.get();
        this.reader = sftpReadable(sftp, this.handle!, { position: this._position, chunkSize: READ_AHEAD_CHUNK }).getReader();
      }
      const { done, value } = await this.reader.read();
      if (done) {
        this.reader = undefined;
        return new Uint8Array(0);
      }
      this.leftover = value;
    }

    const out = this.leftover.subarray(0, size);
    this.leftover = this.leftover.subarray(out.length);
    this._position += out.length;
    return out;
  }

  /** Queue a write at the current position; errors surface on a later call */
  async write(data: Uint8Array): Promise<number> {
    this.assertNotClosed();
    this.assertCanWrite();
    if (this.reader) await this.dropReader();
    await this.settle(WRITES_IN_FLIGHT - 1);

    const sftp = await this.conn.get();
    const copy = data.slice();
    const done: Promise<void> = sftp.write(this.handle!, copy, 0, copy.length, this._position)
      .catch((err) => {
        this.failure ??= err;
      })
      .finally(() => this.pending.delete(done));
    this.pending.add(done);
    this._position += copy.length;
    return copy.length;
  }

  override async sync(): Promise<void> {
    this.assertNotClosed();
    await this.settle();
  }

  override async close(): Promise<void> {
    if (this._closed) return;
    let failure: unknown;
    try {
      await this.settle();
    } catch (err) {
      failure = err;
    }
    await this.dropReader();
    await super.close();

    if (this.handle) {
      const handle = this.handle;
      this.handle = undefined;
      try {
        const sftp = await this.conn.get();
        await sftp.close(handle);
      } catch {
        // the connection went away; the server dropped the handle with it
      }
    }
    this.conn.invalidate(this.id);
    if (failure) throw failure;
  }
}

export class SftpFileRegistry implements FileRegistryIf {
  constructor(private conn: SftpConnection) {}

  async init(): Promise<void> {}

  /** The store owns the connection and ends it */
  async dispose(): Promise<void> {}

  async touch(id: string, _opts: ResourceOptions): Promise<boolean> {
    if (await this.exists(id)) return false;
    const sftp = await this.conn.get();
    await sftp.close(await sftp.open(this.conn.remote(id), 'a'));
    this.conn.invalidate(id);
    return true;
  }

  async open(id: string, opts: ResourceOptions, mode?: ResourceMode): Promise<SftpFileHandle> {
    await ensureResource(this, id, opts, mode);
    const handle = new SftpFileHandle(id, opts, mode || 'r', this, this.conn);
    await handle.init();
    return handle;
  }

  async exists(id: string): Promise<boolean> {
    try {
      await (await this.conn.get()).lstat(this.conn.remote(id));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async stat(id: string): Promise<FileStat> {
    const attrs = await (await this.conn.get()).stat(this.conn.remote(id));
    return {
      size: Number(attrs.size ?? 0),
      mtime: sftpTimeMs(attrs.mtime),
      mode: attrs.mode,
    };
  }

  async statX(id: string): Promise<FileStatX> {
    const stat = await this.stat(id);
    const sftp = await this.conn.get();
    const handle = await sftp.open(this.conn.remote(id), 'r');
    const hasher = createSha256();
    let head = new Uint8Array(0);

    try {
      for await (const chunk of sftpReadable(sftp, handle)) {
        hasher.update(chunk);
        if (head.length < MIME_SAMPLE_BYTES) {
          const more = chunk.subarray(0, MIME_SAMPLE_BYTES - head.length);
          const next = new Uint8Array(head.length + more.length);
          next.set(head);
          next.set(more, head.length);
          head = next;
        }
      }
    } finally {
      await sftp.close(handle).catch(() => {});
    }

    return { ...stat, mimetype: await getMimeFromBuffer(head), sha256: hasher.hex() };
  }

  /** The store's deleteNode usually removed it already; that is not an error */
  async delete(id: string): Promise<boolean> {
    try {
      await (await this.conn.get()).unlink(this.conn.remote(id));
      this.conn.invalidate(id);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async list(id?: string): Promise<AsyncIterable<string>> {
    const entries = await (await this.conn.get()).readdir(this.conn.remote(id ?? '/'));
    return (async function* () {
      for (const entry of entries) yield entry.filename;
    })();
  }

  async count(id?: string): Promise<number> {
    return (await (await this.conn.get()).readdir(this.conn.remote(id ?? '/'))).length;
  }
}
