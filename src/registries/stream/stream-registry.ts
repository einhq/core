import { AbstractResourceHandle, RegistryIf, ResourceHandleIf, ResourceMode, ResourceOptions } from '../types.ts';

/**
 * A stream's registry: a stream keeps nothing. Reading one is a frame its device's driver gives,
 * which the VFS asks for (`FrameHandle`), so a handle opened here holds nothing and takes no write.
 */
export class StreamRegistry implements RegistryIf {
  async init(): Promise<void> {}

  async dispose(): Promise<void> {}

  async touch(_id: string, _opts: ResourceOptions): Promise<boolean> {
    return false;
  }

  async open(id: string, opts: ResourceOptions, mode?: ResourceMode): Promise<ResourceHandleIf> {
    return new EmptyHandle(id, opts, mode ?? 'r', this);
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

class EmptyHandle extends AbstractResourceHandle {
  async read(_size: number | bigint, _signal?: AbortSignal): Promise<Uint8Array> {
    this.assertNotClosed();
    this.assertCanRead();
    return new Uint8Array(0);
  }

  async write(_data: Uint8Array): Promise<number> {
    throw new Error("a stream is its device's live picture, which nothing writes");
  }
}
