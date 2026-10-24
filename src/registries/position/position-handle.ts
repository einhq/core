import { AbstractResourceHandle, RegistryIf, ResourceHandleIf, ResourceMode } from '../types.ts';
import { PositionAsyncIO, PositionResourceOptions, PositionStat } from './types.ts';

export class PositionHandle extends AbstractResourceHandle<PositionResourceOptions, PositionStat> implements ResourceHandleIf<PositionResourceOptions, PositionStat> {
  private consumed = false;

  constructor(
    id: string,
    options: PositionResourceOptions,
    mode: ResourceMode,
    registry: RegistryIf<PositionResourceOptions, PositionStat>,
    private io: PositionAsyncIO,
  ) {
    super(id, options, mode, registry);
  }

  /** Return the byte size of the stored position data. */
  override async size(): Promise<number> {
    const stat = await this.registry.stat(this.id);
    return stat.size;
  }

  /** Read the position data as raw bytes (JSON encoded). Returns empty on subsequent calls (EOF). */
  async read(_size: number, _signal?: AbortSignal): Promise<Uint8Array> {
    this.assertNotClosed();
    this.assertCanRead();

    if (this.consumed) return new Uint8Array(0);
    this.consumed = true;
    return this.io.get();
  }

  /** Write position data. Returns the number of bytes written. */
  async write(data: Uint8Array): Promise<number> {
    this.assertNotClosed();
    this.assertCanWrite();

    await this.io.set(data);

    return data.length;
  }
}
