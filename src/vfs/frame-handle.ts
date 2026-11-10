import { AbstractResourceHandle, type RegistryIf, type ResourceMode, type ResourceOptions } from '../registries/types.ts';

/**
 * What the VFS hands a reader of a stream: one frame, asked of the device's driver at the first read
 * (`fetch`), then read out as a file's bytes are, so `cat /dev/front-door/main > door.jpg` works.
 * Nothing is kept: each open is a new frame.
 */
export class FrameHandle extends AbstractResourceHandle {
  #bytes?: Uint8Array;
  #at = 0;

  constructor(
    id: string,
    options: ResourceOptions,
    mode: ResourceMode,
    registry: RegistryIf,
    private readonly fetch: () => Promise<Uint8Array>,
  ) {
    super(id, options, mode, registry);
  }

  async read(size: number | bigint, _signal?: AbortSignal): Promise<Uint8Array> {
    this.assertNotClosed();
    this.assertCanRead();
    this.#bytes ??= await this.fetch();
    const end = Math.min(this.#bytes.length, this.#at + Number(size));
    const chunk = this.#bytes.subarray(this.#at, end);
    this.#at = end;
    return chunk;
  }

  async write(_data: Uint8Array): Promise<number> {
    throw new Error("a stream is its device's live picture, which nothing writes");
  }
}
