import { AbstractResourceHandle, RegistryIf, ResourceHandleIf, ResourceMode } from '../types.ts';
import { EmbeddingAsyncIO, EmbeddingResourceOptions, EmbeddingStat } from './types.ts';

export class EmbeddingHandle extends AbstractResourceHandle<EmbeddingResourceOptions, EmbeddingStat> implements ResourceHandleIf<EmbeddingResourceOptions, EmbeddingStat> {
  private consumed = false;

  constructor(
    id: string,
    options: EmbeddingResourceOptions,
    mode: ResourceMode,
    registry: RegistryIf<EmbeddingResourceOptions, EmbeddingStat>,
    private io: EmbeddingAsyncIO,
  ) {
    super(id, options, mode, registry);
  }

  /** Return the byte size of the stored embedding vector. */
  override async size(): Promise<number> {
    const stat = await this.registry.stat(this.id);
    return stat.size;
  }

  /** Read the embedding vector data as raw bytes. Returns empty on subsequent calls (EOF). */
  async read(_size: number, _signal?: AbortSignal): Promise<Uint8Array> {
    this.assertNotClosed();
    this.assertCanRead();

    if (this.consumed) return new Uint8Array(0);
    this.consumed = true;
    return this.io.get();
  }

  /** Write embedding vector data. Returns the number of bytes written. */
  async write(data: Uint8Array): Promise<number> {
    this.assertNotClosed();
    this.assertCanWrite();

    await this.io.set(data);

    return data.length;
  }
}
