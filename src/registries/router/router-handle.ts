import { AbstractResourceHandle, RegistryIf, ResourceHandleIf, ResourceMode } from '../types.ts';
import { RouterResourceOptions, RouterStat } from './types.ts';

export class RouterHandle extends AbstractResourceHandle<RouterResourceOptions, RouterStat> implements ResourceHandleIf<RouterResourceOptions, RouterStat> {
  constructor(
    id: string,
    options: RouterResourceOptions,
    mode: ResourceMode,
    registry: RegistryIf<RouterResourceOptions, RouterStat>,
    private onWriteFn: (data: Uint8Array) => Promise<void>,
    private onReadFn: (signal?: AbortSignal) => Promise<Uint8Array>,
  ) {
    super(id, options, mode, registry);
  }

  async read(
    _size: number | bigint,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    this.assertNotClosed();
    this.assertCanRead();

    return await this.onReadFn(signal);
  }

  async write(data: Uint8Array): Promise<number> {
    this.assertNotClosed();
    this.assertCanWrite();

    await this.onWriteFn(data);

    return data.length;
  }
}
