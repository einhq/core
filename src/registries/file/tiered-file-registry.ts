/**
 * TieredFileRegistry - routes a file's bytes to one of several backing
 * registries based on its storage tier (see {@link tierOf}). It holds
 * references to existing, unmodified registries (DiskFileRegistry for the
 * disk/volatile tiers, a PgBlob-backed registry for the db tier) and delegates
 * every operation to the right one.
 *
 * Routing needs the node attrs: `touch`/`open`/`stat`/`statX`/`delete` receive
 * them as `opts`. `exists`/`list`/`count` (and any call without attrs) fan out
 * across backends, which is safe because ids are globally unique ULIDs.
 */

import { ResourceHandleIf, ResourceMode, ResourceOptions } from '../types.ts';
import { tierOf } from './tier.ts';
import { FileRegistryIf, FileStat, FileStatX, FileTier } from './types.ts';

type TieredFileRegistryBackends = {
  /** Durable store for originals and frozen RAW versions (required). */
  disk: FileRegistryIf;
  /** Fast store for regenerable renditions. Falls back to `disk` if omitted. */
  volatile?: FileRegistryIf;
  /** PostgreSQL LOB store for small content. Falls back to `disk` if omitted. */
  db?: FileRegistryIf;
};

export class TieredFileRegistry implements FileRegistryIf {
  private readonly disk: FileRegistryIf;
  private readonly volatile?: FileRegistryIf;
  private readonly db?: FileRegistryIf;

  constructor(backends: TieredFileRegistryBackends) {
    this.disk = backends.disk;
    this.volatile = backends.volatile;
    this.db = backends.db;
  }

  /** Distinct backend instances (dedupes shared instances, e.g. volatile === disk). */
  private uniqueBackends(): FileRegistryIf[] {
    return [...new Set([this.disk, this.volatile, this.db].filter((b): b is FileRegistryIf => !!b))];
  }

  private backendFor(tier: FileTier): FileRegistryIf {
    switch (tier) {
      case 'volatile':
        return this.volatile ?? this.disk;
      case 'db':
        return this.db ?? this.disk;
      default:
        return this.disk;
    }
  }

  private route(opts?: ResourceOptions): FileRegistryIf {
    return this.backendFor(tierOf(opts));
  }

  /** Find the backend that actually holds `id` (used when attrs are unavailable). */
  private async probe(id: string): Promise<FileRegistryIf | undefined> {
    for (const backend of this.uniqueBackends()) {
      if (await backend.exists(id)) {
        return backend;
      }
    }

    return undefined;
  }

  async init(): Promise<void> {
    for (const backend of this.uniqueBackends()) {
      await backend.init();
    }
  }

  async dispose(): Promise<void> {
    for (const backend of this.uniqueBackends()) {
      await backend.dispose();
    }
  }

  touch(id: string, opts: ResourceOptions): Promise<boolean> {
    return this.route(opts).touch(id, opts);
  }

  open(
    id: string,
    opts: ResourceOptions,
    mode?: ResourceMode,
  ): Promise<ResourceHandleIf<ResourceOptions, FileStat, FileStatX>> {
    return this.route(opts).open(id, opts, mode);
  }

  async exists(id: string): Promise<boolean> {
    return (await this.probe(id)) !== undefined;
  }

  async stat(id: string, opts?: ResourceOptions): Promise<FileStat> {
    const backend = opts !== undefined ? this.route(opts) : await this.probe(id);
    if (!backend) {
      throw new Error(`no file found: ${id}`);
    }

    return backend.stat(id, opts);
  }

  async statX(id: string, opts?: ResourceOptions): Promise<FileStatX> {
    const backend = opts !== undefined ? this.route(opts) : await this.probe(id);
    if (!backend) {
      throw new Error(`no file found: ${id}`);
    }

    return backend.statX(id, opts);
  }

  async delete(id: string, opts?: ResourceOptions): Promise<boolean> {
    if (opts !== undefined) {
      return this.route(opts).delete(id, opts);
    }

    // No attrs: delete from whichever backend holds it.
    let deleted = false;
    for (const backend of this.uniqueBackends()) {
      if (await backend.delete(id)) {
        deleted = true;
      }
    }

    return deleted;
  }

  async list(id?: string): Promise<AsyncIterable<string>> {
    const backends = this.uniqueBackends();
    const iterables = await Promise.all(backends.map((b) => b.list(id)));

    return (async function* () {
      const seen = new Set<string>();
      for (const it of iterables) {
        for await (const name of it) {
          if (!seen.has(name)) {
            seen.add(name);
            yield name;
          }
        }
      }
    })();
  }

  async count(id?: string): Promise<number> {
    let count = 0;
    for await (const _name of await this.list(id)) {
      count++;
    }

    return count;
  }
}
