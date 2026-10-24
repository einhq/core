import { createSha256 } from '../../lib/hash/mod.ts';
import { getMimeFromBuffer } from '../../lib/media/mod.ts';
import { ensureResource, type ResourceMode, type ResourceOptions } from '../types.ts';
import { MemoryBlobHandle } from './memory-blob-handle.ts';
import type { BlobIO, BlobRegistryIf, BlobStat, BlobStatX } from './types.ts';

export class MemoryBlobRegistry implements BlobRegistryIf {
  private blobs: Map<string, Uint8Array> = new Map();

  async init(): Promise<void> {}

  async dispose(): Promise<void> {
    this.blobs.clear();
  }

  async touch(id: string, _opts: ResourceOptions): Promise<boolean> {
    if (this.blobs.has(id)) return false;
    this.blobs.set(id, new Uint8Array(0));
    return true;
  }

  async open(
    id: string,
    opts: ResourceOptions,
    mode?: ResourceMode,
  ): Promise<MemoryBlobHandle> {
    await ensureResource(this, id, opts, mode);

    const io: BlobIO = {
      get: () => this.blobs.get(id)!,
      set: (data: Uint8Array) => this.blobs.set(id, data),
    };

    const rh = new MemoryBlobHandle(id, opts, mode || 'r', this, io);
    await rh.init();

    return rh;
  }

  async exists(id: string): Promise<boolean> {
    return this.blobs.has(id);
  }

  async stat(id: string): Promise<BlobStat> {
    const data = this.blobs.get(id);

    if (!data) {
      throw new Error(`resource not found: ${id}`);
    }

    return { size: data.length };
  }

  async statX(id: string): Promise<BlobStatX> {
    const stat = await this.stat(id);
    const data = this.blobs.get(id)!;
    const hasher = createSha256();

    hasher.update(data);

    return {
      ...stat,
      mimetype: await getMimeFromBuffer(data),
      sha256: hasher.hex(),
    };
  }

  async delete(id: string): Promise<boolean> {
    if (!this.blobs.has(id)) return false;
    this.blobs.delete(id);
    return true;
  }

  async list(id?: string): Promise<AsyncIterable<string>> {
    let all = Array.from(this.blobs.keys());

    if (id) {
      const path = id.replace(/\/+$/, '');
      all = all
        .filter((s) => s.startsWith(`${path}/`))
        .map((s) => s.replace(path, ''));
    }

    // Scoped ids are '/child/...' after the prefix strip; unscoped ids may be
    // flat (no slash), in which case the id itself is the name
    const items = [
      ...new Set(
        all.map((s) => s.split('/').filter(Boolean)[0] ?? s),
      ),
    ];

    return (async function* () {
      for (const item of items) {
        yield item;
      }
    })();
  }

  async count(id?: string): Promise<number> {
    const it = await this.list(id);
    let count = 0;

    for await (const _item of it) {
      count++;
    }

    return count;
  }
}
