import { AbstractResourceHandle, modeFlags, type RegistryIf, type ResourceMode, type ResourceOptions, ResourceSeekMode } from '../types.ts';
import type { BlobIO, BlobStat, BlobStatX } from './types.ts';

export class MemoryBlobHandle extends AbstractResourceHandle<ResourceOptions, BlobStat, BlobStatX> {
  private offset = 0;
  private append: boolean;

  constructor(
    id: string,
    options: ResourceOptions,
    mode: ResourceMode,
    registry: RegistryIf<ResourceOptions, BlobStat, BlobStatX>,
    private io: BlobIO,
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

  override async size(): Promise<number> {
    return this.data.length;
  }

  override async seek(
    offset: number,
    whence: ResourceSeekMode,
  ): Promise<number> {
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

  /** Write bytes at the current offset, or at the end in append mode. */
  async write(data: Uint8Array): Promise<number> {
    this.assertNotClosed();
    this.assertCanWrite();

    if (this.append) {
      this.offset = this.data.length;
    }

    const requiredSize = this.offset + data.length;
    if (requiredSize > this.data.length) {
      const newContent = new Uint8Array(requiredSize);
      newContent.set(this.data);
      this.data = newContent;
    }

    this.data.set(data, this.offset);
    this.offset += data.length;

    return data.length;
  }
}
