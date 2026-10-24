import { createSha256 } from '../../lib/hash/mod.ts';
import { getMimeFromBuffer } from '../../lib/media/mod.ts';
import { ensureResource, ResourceMode, ResourceOptions } from '../types.ts';
import { MemoryFileHandle } from './memory-file-handle.ts';
import { FileIO, FileRegistryIf, FileStat, FileStatX } from './types.ts';

/** One file's content and its created and last-modified times, in epoch milliseconds. */
type MemoryFile = { data: Uint8Array; birthtime: number; mtime: number };

/** File content in memory. */
export class MemoryFileRegistry implements FileRegistryIf {
  private files: Map<string, MemoryFile> = new Map();

  /** Initializes the registry. No-op for the in-memory implementation. */
  async init(): Promise<void> {}

  /** Disposes the registry by clearing all stored files from memory. */
  async dispose(): Promise<void> {
    this.files.clear();
  }

  /** Creates an empty file entry if it does not already exist. Returns true if created. */
  async touch(id: string, _opts: ResourceOptions): Promise<boolean> {
    if (this.files.has(id)) {
      return false;
    }

    const now = Date.now();
    this.files.set(id, { data: new Uint8Array(0), birthtime: now, mtime: now });
    return true;
  }

  /** Opens a file by id and returns a MemoryFileHandle for reading/writing. */
  async open(id: string, opts: ResourceOptions, mode?: ResourceMode): Promise<MemoryFileHandle> {
    await ensureResource(this, id, opts, mode);

    const file = this.files.get(id)!;
    const io: FileIO = {
      get: () => file.data,
      set: (data: Uint8Array) => {
        file.data = data;
        file.mtime = Date.now();
      },
    };

    const rh = new MemoryFileHandle(id, opts, mode || 'r', this, io);
    await rh.init();

    return rh;
  }

  /** Checks whether a file with the given id exists in memory. */
  async exists(id: string): Promise<boolean> {
    return this.files.has(id);
  }

  /** Returns the size and the created and modified times. Throws if the file does not exist. */
  async stat(id: string): Promise<FileStat> {
    const file = this.files.get(id);

    if (!file) {
      throw new Error(`no file found: ${id}`);
    }

    return {
      size: file.data.length,
      mtime: file.mtime,
      birthtime: file.birthtime,
    };
  }

  /** Returns extended stats including SHA-256 hash and detected MIME type. */
  async statX(id: string): Promise<FileStatX> {
    const stat = await this.stat(id);
    const { data } = this.files.get(id)!;
    const hasher = createSha256();

    hasher.update(data);

    return {
      ...stat,
      mimetype: await getMimeFromBuffer(data),
      sha256: hasher.hex(),
    };
  }

  /** Removes a file from memory. Returns true if the file existed and was deleted. */
  async delete(id: string): Promise<boolean> {
    const exists = this.files.has(id);

    if (exists) {
      this.files.delete(id);

      return true;
    }

    return false;
  }

  /** Lists immediate child names under the given path, or all top-level keys if no id. */
  async list(id?: string): Promise<AsyncIterable<string>> {
    let all = Array.from(this.files.keys());

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

  /** Counts the number of entries returned by list(). */
  async count(id?: string): Promise<number> {
    const it = await this.list(id);
    let count = 0;

    for await (const _item of it) {
      count++;
    }

    return count;
  }
}
