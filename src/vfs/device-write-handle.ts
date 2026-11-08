import { AbstractResourceHandle, type RegistryIf, type ResourceMode, type ResourceOptions } from '../registries/types.ts';

/**
 * What the VFS hands a writer of a device or a control: the bytes are kept until the writer closes,
 * then given to the device's driver whole (`onClose`), and the writer hears its answer from the
 * close, so `echo on > /dev/hall-plug/switch` fails when the driver refuses. Nothing is written
 * anywhere by the handle itself; a close with nothing written gives the driver nothing.
 */
export class DeviceWriteHandle extends AbstractResourceHandle {
  #chunks: Uint8Array[] = [];
  #length = 0;

  constructor(
    id: string,
    options: ResourceOptions,
    mode: ResourceMode,
    registry: RegistryIf,
    private readonly onClose: (bytes: Uint8Array) => Promise<void>,
  ) {
    super(id, options, mode, registry);
  }

  async read(_size: number | bigint, _signal?: AbortSignal): Promise<Uint8Array> {
    throw new Error('a device or control opened for writing is not read');
  }

  async write(data: Uint8Array): Promise<number> {
    this.assertNotClosed();
    this.assertCanWrite();
    this.#chunks.push(data.slice());
    this.#length += data.length;
    return data.length;
  }

  override async close(): Promise<void> {
    if (this.closed) return;
    await super.close();
    if (this.#length === 0) return;
    const bytes = new Uint8Array(this.#length);
    let at = 0;
    for (const chunk of this.#chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    this.#chunks = [];
    await this.onClose(bytes);
  }
}
