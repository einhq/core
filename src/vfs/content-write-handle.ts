import type { ResourceHandleIf, ResourceMode, ResourceOptions, ResourceSeekMode, ResourceStat } from '../registries/types.ts';

/**
 * A handle that reports, once it is closed, that bytes were written through it.
 *
 * For a node whose content has no attr to describe it — a `position`, whose
 * shape lives in the registry: the report is what makes a write visible to
 * subscribers. A rule reacting to the node's `created` event runs before the
 * point exists, since writers `ensure` the node first and write it second.
 *
 * Reported after the inner close, so the content is committed by the time anyone
 * reacts to it, and only when something was written: opening for write and
 * closing without a byte changes nothing.
 */
export class ContentWriteHandle implements ResourceHandleIf {
  #written = false;

  constructor(private readonly inner: ResourceHandleIf, private readonly onWritten: () => Promise<void>) {}

  get id(): string {
    return this.inner.id;
  }
  get options(): ResourceOptions {
    return this.inner.options;
  }
  get closed(): boolean {
    return this.inner.closed;
  }
  get mode(): ResourceMode {
    return this.inner.mode;
  }
  get signal(): AbortSignal {
    return this.inner.signal;
  }
  get readable(): ReadableStream<Uint8Array> {
    return this.inner.readable;
  }
  /** A piped write is a write too. */
  get writable(): WritableStream<Uint8Array> {
    const writer = this.inner.writable.getWriter();

    return new WritableStream<Uint8Array>({
      write: async (chunk) => {
        await writer.write(chunk);
        this.#written = true;
      },
      close: () => writer.close(),
      abort: (reason) => writer.abort(reason),
    });
  }

  init(): Promise<void> {
    return this.inner.init();
  }
  size(): Promise<number> {
    return this.inner.size();
  }
  stat(): Promise<ResourceStat> {
    return this.inner.stat();
  }
  statX(): Promise<ResourceStat> {
    return this.inner.statX();
  }
  seek(offset: number, whence: ResourceSeekMode): Promise<number> {
    return this.inner.seek(offset, whence);
  }
  read(size: number, signal?: AbortSignal): Promise<Uint8Array> {
    return this.inner.read(size, signal);
  }
  async write(data: Uint8Array): Promise<number> {
    const written = await this.inner.write(data);
    this.#written = true;
    return written;
  }
  async writeEOF(): Promise<void> {
    // The default writeEOF() closes the inner handle, so it is where the report goes too.
    await this.inner.writeEOF();
    await this.#report();
  }
  sync(): Promise<void> {
    return this.inner.sync();
  }
  async close(): Promise<void> {
    await this.inner.close();
    await this.#report();
  }

  async #report(): Promise<void> {
    if (!this.#written) return;
    this.#written = false;
    await this.onWritten();
  }
}
