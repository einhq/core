import { AbstractResourceHandle, modeFlags, RegistryIf, ResourceHandleIf, ResourceMode, ResourceOptions, ResourceSeekMode } from '../types.ts';
import { FileIO, FileStat, FileStatX } from './types.ts';

export class MemoryFileHandle extends AbstractResourceHandle<ResourceOptions, FileStat, FileStatX> implements ResourceHandleIf<ResourceOptions, FileStat, FileStatX> {
  private offset = 0;
  private append: boolean;

  constructor(
    id: string,
    options: ResourceOptions,
    mode: ResourceMode,
    registry: RegistryIf<ResourceOptions, FileStat, FileStatX>,
    private io: FileIO,
  ) {
    super(id, options, mode, registry);

    const { truncate, append } = modeFlags(mode);
    this.append = append;

    if (truncate) {
      this.data = new Uint8Array(0);
    } else if (append) {
      this.offset = this.data.length;
    }
  }

  private get data(): Uint8Array {
    return this.io.get();
  }

  private set data(data: Uint8Array) {
    this.io.set(data);
  }

  /** Returns the current size of the in-memory data buffer in bytes. */
  override async size(): Promise<number> {
    return this.data.length;
  }

  /** Moves the read/write cursor to the given offset relative to whence. Returns the new position. */
  override async seek(offset: number, whence: ResourceSeekMode): Promise<number> {
    this.assertNotClosed();

    switch (whence) {
      case ResourceSeekMode.Start:
        return this.offset = offset;
      case ResourceSeekMode.Current:
        return this.offset += offset;
      case ResourceSeekMode.End:
        return this.offset = this.data.length + offset;
    }
  }

  /** Read up to size; waits if empty. Returns empty on EOF. */
  async read(size: number, _signal?: AbortSignal): Promise<Uint8Array> {
    this.assertNotClosed();
    this.assertCanRead();

    const out = new Uint8Array(size);

    if (this.offset >= this.data.length) {
      return new Uint8Array(0);
    }

    const bytesToRead = Math.min(out.length, this.data.length - this.offset);
    out.set(this.data.subarray(this.offset, this.offset + bytesToRead));
    this.offset += bytesToRead;

    if (bytesToRead < size) {
      return out.slice(0, bytesToRead);
    }

    return out;
  }

  /** Write bytes at the current offset, or at the end in append mode. Throws if closed. */
  async write(data: Uint8Array): Promise<number> {
    this.assertNotClosed();
    this.assertCanWrite();

    if (this.append) {
      this.offset = this.data.length;
    }

    let content = this.data;
    const requiredSize = this.offset + data.length;
    if (requiredSize > content.length) {
      content = new Uint8Array(requiredSize);
      content.set(this.data);
    }

    content.set(data, this.offset);
    this.data = content;
    this.offset += data.length;

    return data.length;
  }
}
