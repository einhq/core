/** File content on the local filesystem, bucketed under one root directory. */

import { createSha256 } from '../../lib/hash/mod.ts';
import { dirname, join, normalize } from '@std/path';
import { getMimeFromBuffer, MIME_SAMPLE_BYTES } from '../../lib/media/mod.ts';
import { ensureResource, ResourceMode, ResourceOptions } from '../types.ts';
import { DiskFileHandle } from './disk-file-handle.ts';
import { FileRegistryIf, FileStat, FileStatX } from './types.ts';

type DiskFileRegistryConfig = {
  rootPath: string;
};

export class DiskFileRegistry implements FileRegistryIf {
  private initialized = false;
  constructor(private config: DiskFileRegistryConfig) {}

  /** Initializes the registry by ensuring the root directory exists. */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await Deno.mkdir(this.config.rootPath, { recursive: true });

    this.initialized = true;
  }

  /** Releases any held resources. */
  async dispose(): Promise<void> {}

  private getAbspath(id: string): string {
    if (id.startsWith('/')) {
      return normalize(join(this.config.rootPath as string, id));
    }

    // Uses bucketed storage: {rootPath}/{id[-2:]}/{id}
    // Last 2 chars are from ULID's random suffix, giving uniform distribution
    const bucket = id.slice(-2);
    return normalize(join(this.config.rootPath as string, bucket, id));
  }

  /** Creates an empty file if it does not already exist. Returns true if created. */
  async touch(id: string, _opts: ResourceOptions): Promise<boolean> {
    if (await this.exists(id)) {
      return false;
    }

    const abspath = this.getAbspath(id);

    await Deno.mkdir(dirname(abspath), { recursive: true });
    (await Deno.open(abspath, { create: true, append: true })).close();

    return true;
  }

  /** Opens a file by id and returns a DiskFileHandle for reading/writing. */
  async open(id: string, opts: ResourceOptions, mode?: ResourceMode): Promise<DiskFileHandle> {
    await ensureResource(this, id, opts, mode);

    const abspath = this.getAbspath(id);

    const rh = new DiskFileHandle(id, opts, mode || 'r', this, abspath);
    await rh.init();

    return rh;
  }

  /** Checks whether a file with the given id exists on disk. */
  async exists(id: string): Promise<boolean> {
    const abspath = this.getAbspath(id);

    try {
      await Deno.stat(abspath);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        throw err;
      }

      return false;
    }

    return true;
  }

  /** Returns basic file stats (size, timestamps, permissions). */
  async stat(id: string): Promise<FileStat> {
    const abspath = this.getAbspath(id);
    const stat = await Deno.stat(abspath);

    return {
      size: stat.size,
      mtime: stat.mtime?.getTime(),
      birthtime: stat.birthtime?.getTime(),
      path: abspath,
      mode: stat.mode !== null ? stat.mode : undefined,
      uid: stat.uid !== null ? stat.uid : undefined,
      gid: stat.gid !== null ? stat.gid : undefined,
    };
  }

  /** Returns extended stats including SHA-256 hash and detected MIME type. */
  async statX(id: string): Promise<FileStatX> {
    const stat = await this.stat(id);
    const abspath = this.getAbspath(id);
    const file = await Deno.open(abspath, { read: true });
    const hasher = createSha256();
    const buffer = new Uint8Array(64 * 1024);

    let size = 0;
    let firstBytes = new Uint8Array(0);

    try {
      while (true) {
        const n = await file.read(buffer);
        if (n === null) {
          break;
        }

        const chunk = buffer.subarray(0, n);
        hasher.update(chunk);
        size += n;

        if (firstBytes.byteLength < MIME_SAMPLE_BYTES) {
          const remaining = MIME_SAMPLE_BYTES - firstBytes.byteLength;
          const slice = chunk.subarray(0, remaining);

          const tmp = new Uint8Array(firstBytes.byteLength + slice.byteLength);
          tmp.set(firstBytes);
          tmp.set(slice, firstBytes.byteLength);
          firstBytes = tmp;
        }
      }
    } finally {
      file.close();
    }

    return {
      ...stat,
      mimetype: await getMimeFromBuffer(firstBytes),
      sha256: hasher.hex(),
    };
  }

  /** Deletes a file by id and cleans up empty bucket directories. Returns true if deleted. */
  async delete(id: string): Promise<boolean> {
    const abspath = this.getAbspath(id);

    try {
      await Deno.remove(abspath);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        throw err;
      }

      return false;
    }

    // Clean up empty bucket directory
    if (!id.startsWith('/')) {
      const parentPath = dirname(abspath);

      try {
        // Explicitly NOT setting recursive flag here,
        // so it will fail if there are other files
        await Deno.remove(parentPath);
      } catch {
        // Bucket doesn't exist or not empty - OK
      }
    }

    return true;
  }

  /**
   * Lists the ids of bucketed files, or the names in the directory of a path id. A bucket is
   * the directory named after the last two characters of the ids it holds.
   */
  async list(id?: string): Promise<AsyncIterable<string>> {
    if (id) {
      const abspath = this.getAbspath(id);

      return (async function* () {
        for await (const item of Deno.readDir(abspath)) {
          yield item.name;
        }
      })();
    }

    const root = this.config.rootPath as string;

    return (async function* () {
      for await (const bucket of Deno.readDir(root)) {
        if (!bucket.isDirectory || bucket.name.length !== 2) continue;

        for await (const item of Deno.readDir(join(root, bucket.name))) {
          if (item.isFile && item.name.endsWith(bucket.name)) yield item.name;
        }
      }
    })();
  }

  /** Counts what {@link list} yields. */
  async count(id?: string): Promise<number> {
    let count = 0;

    for await (const _item of await this.list(id)) {
      count++;
    }

    return count;
  }
}
