import { ensureResource, RegistryIf, ResourceMode } from '../../registries/types.ts';
import { BufferHandle } from './buffer-handle.ts';
import { Pipe } from './pipe.ts';
import { BufferManagerIf, BufferResourceOptions, BufferStat } from './types.ts';

export class BufferManager implements BufferManagerIf {
  private pipes: Map<string, Pipe> = new Map();

  async init(): Promise<void> {}

  async dispose(): Promise<void> {
    for (const pipe of this.pipes.values()) {
      pipe.close();
    }

    this.pipes.clear();
  }

  async touch(id: string, opts: BufferResourceOptions): Promise<boolean> {
    if (this.pipes.has(id)) {
      return false;
    }

    const capacity = opts.capacity ?? 64 * 1024;

    this.pipes.set(id, new Pipe(capacity));
    return true;
  }

  async open(id: string, opts: BufferResourceOptions, mode?: ResourceMode): Promise<BufferHandle> {
    await ensureResource(this as unknown as RegistryIf<BufferResourceOptions, BufferStat>, id, opts, mode);

    const pipe = this.pipes.get(id)!;
    const rh = new BufferHandle(id, opts, mode || 'r', this as unknown as RegistryIf<BufferResourceOptions, BufferStat>, pipe);
    await rh.init();

    return rh;
  }

  async exists(id: string): Promise<boolean> {
    return this.pipes.has(id);
  }

  async stat(id: string): Promise<BufferStat> {
    const pipe = this.pipes.get(id);

    if (!pipe) {
      throw new Error(`no buffer found: ${id}`);
    }

    return {
      capacity: pipe.capacity,
      size: pipe.size,
    };
  }

  async delete(id: string): Promise<boolean> {
    const pipe = this.pipes.get(id);

    if (pipe) {
      pipe.close();
      this.pipes.delete(id);

      return true;
    }

    return false;
  }

  async closeRead(id: string): Promise<void> {
    this.pipes.get(id)?.closeRead();
  }

  async list(_id?: string): Promise<AsyncIterable<string>> {
    const items = Array.from(this.pipes.keys());

    return (async function* () {
      for (const item of items) {
        yield item;
      }
    })();
  }

  async count(_id?: string): Promise<number> {
    return this.pipes.size;
  }
}
