import { AbstractResourceHandle, RegistryIf, ResourceHandleIf, ResourceMode } from '../../registries/types.ts';
import { Pipe } from './pipe.ts';
import { BufferResourceOptions, BufferStat } from './types.ts';

export class BufferHandle extends AbstractResourceHandle<BufferResourceOptions, BufferStat> implements ResourceHandleIf<BufferResourceOptions, BufferStat> {
  /** Create a handle wrapping a Pipe with the given mode and registry. */
  constructor(
    id: string,
    options: BufferResourceOptions,
    mode: ResourceMode,
    registry: RegistryIf<BufferResourceOptions, BufferStat>,
    private pipe: Pipe,
  ) {
    super(id, options, mode, registry);
  }

  /** Return the number of bytes currently buffered in the pipe. */
  override async size(): Promise<number> {
    return this.pipe.size;
  }

  /** Signal EOF to readers by closing the underlying pipe. */
  override async writeEOF(): Promise<void> {
    this.pipe.close();
  }

  /** Write bytes. Waits while the pipe is full. Throws if closed. */
  async write(data: Uint8Array): Promise<number> {
    this.assertNotClosed();
    this.assertCanWrite();

    return await this.pipe.write(data);
  }

  /** Read up to size; waits if empty. Returns empty on EOF. */
  async read(size: number, signal?: AbortSignal): Promise<Uint8Array> {
    this.assertNotClosed();
    this.assertCanRead();

    return await this.pipe.read(size, signal);
  }
}
