import { AbstractResourceHandle, RegistryIf, ResourceHandleIf, ResourceMode, ResourceOptions } from '../types.ts';

/** `/dev/null`'s registry: it holds nothing, so every id exists and every handle is empty. */
export class NullRegistry implements RegistryIf {
  async init(): Promise<void> {}

  async dispose(): Promise<void> {}

  async touch(_id: string, _opts: ResourceOptions): Promise<boolean> {
    return false;
  }

  async open(id: string, opts: ResourceOptions, mode?: ResourceMode): Promise<ResourceHandleIf> {
    return new NullHandle(id, opts, mode ?? 'r', this);
  }

  async exists(_id: string): Promise<boolean> {
    return true;
  }

  async stat(_id: string): Promise<Record<string, unknown>> {
    return { size: 0 };
  }

  async statX(id: string): Promise<Record<string, unknown>> {
    return await this.stat(id);
  }

  async delete(_id: string): Promise<boolean> {
    return true;
  }

  async list(_id?: string): Promise<AsyncIterable<string>> {
    return (async function* () {})();
  }

  async count(_id?: string): Promise<number> {
    return 0;
  }
}

/** A read ends at once; a write is accepted whole and discarded. */
class NullHandle extends AbstractResourceHandle {
  async read(_size: number | bigint, _signal?: AbortSignal): Promise<Uint8Array> {
    this.assertNotClosed();
    this.assertCanRead();

    return new Uint8Array(0);
  }

  async write(data: Uint8Array): Promise<number> {
    this.assertNotClosed();
    this.assertCanWrite();

    return data.length;
  }
}
