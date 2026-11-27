/**
 * What `unzip` and `tar` share when they expand an archive into a directory: what each directory
 * already holds, making the directories an archive names without following a softlink out of the
 * target, deciding what to do with a file already at an entry's path, and streaming an entry's
 * bytes into its file node with what an upload records.
 */

import { basename, dirname, join } from '@std/path';
import type { Access } from '../../../../lib/access/mod.ts';
import { createFileAttrsCollector } from '../../../../lib/media/file-attrs.ts';
import { freezes, type FrozenUploads } from '../../../../lib/media/frozen-uploads.ts';
import { getMimeFromExt } from '../../../../lib/media/mime.ts';
import { sampleDisk } from '../../../../lib/metrics/disk.ts';
import { humanizeSize } from '../../../../lib/utils/humanize-size.ts';
import { NodeNotFoundError, type NodeVFS } from '../../../../vfs/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../../../vfs/types/directory.ts';
import { type FileAttrs, NODE_TYPE_FILE } from '../../../../vfs/types/file.ts';
import { NODE_TYPE_SOFTLINK } from '../../../../vfs/types/softlink.ts';
import type { Command } from '../../command.ts';

/** The free space an expansion must find, as a multiple of the bytes it will write. */
export const SPACE_FACTOR = 1.1;

/** Children read per page when listing what a directory already holds. */
const LISTING_PAGE = 1000;

/** Why an archive is not expanded at all: nothing has been written when this is thrown. */
export class ExpandRefusedError extends Error {}

/** A node already at an entry's path. `written` is false for a file whose last write never finished: no write recorded its sha256. */
type Existing = { type: string; size: number; written: boolean };

/** What to do with a file entry: write it, into a new node (`create`) or over one, or leave the one there. */
type FilePlan = 'create' | 'write' | 'skip';

/** What a written file is given besides its bytes. */
type WriteOptions = {
  /** The entry's modification time, recorded as `writtenAt`. */
  writtenAt?: Date;
  /** The types a written file is frozen by, as an upload is; none freezes nothing. */
  frozenUploads?: FrozenUploads;
};

/** An archive's names below `directory` as the directory and the name an entry lands at, or undefined for the directory itself. */
type Target = { dir: string; name: string };

/**
 * The names of an entry's path, split on `/` with empty and `.` names dropped, or undefined when it
 * would land outside the directory: an absolute path, or one with a `..` name.
 */
export const entryNames = (path: string): string[] | undefined => {
  if (path.startsWith('/')) return undefined;
  const names = path.split('/').filter((name) => name !== '' && name !== '.');
  return names.includes('..') ? undefined : names;
};

/**
 * One archive's expansion into `directory`. It reads each directory the entries reach once and
 * keeps that up to date as it writes, and counts the directories it makes.
 */
export class Expansion {
  /** Directories made; those already there are not counted. */
  directories = 0;

  #listings = new Map<string, Map<string, Existing>>();
  #made = new Set<string>();

  constructor(
    private vfs: NodeVFS,
    private access: Access,
    readonly directory: string,
    /** The command's name, for a refusal's message. */
    private command: string,
    /** The flag that writes over a file already there, for the message that says it is. */
    private overwriteFlag: string,
  ) {}

  /** Where the entry `names` lands, or undefined for none (the directory itself). */
  target(names: string[]): Target | undefined {
    if (names.length === 0) return undefined;
    return { dir: join(this.directory, ...names.slice(0, -1)), name: names[names.length - 1] };
  }

  /**
   * What `dir` holds, by name: empty for one that does not exist yet. One below the directory that
   * cannot be read is empty too: its entries fail when they are written, each saying why.
   */
  async listing(dir: string): Promise<Map<string, Existing>> {
    let names = this.#listings.get(dir);
    if (names) return names;
    names = new Map();
    try {
      let after: string | undefined;
      while (true) {
        const page = await this.vfs.children<FileAttrs>(this.access, dir, { page: { limit: LISTING_PAGE, after } });
        for (const child of page) {
          const { type, attrs } = child.node;
          names.set(child.name, { type, size: Number(attrs.size ?? 0), written: type !== NODE_TYPE_FILE || !!attrs.sha256 });
        }
        if (page.length < LISTING_PAGE) break;
        after = page[page.length - 1].name;
      }
    } catch (error) {
      if (!(error instanceof NodeNotFoundError) && dir === this.directory) throw error;
      names.clear();
    }
    this.#listings.set(dir, names);
    return names;
  }

  /** Record that `name` in `dir` is now `existing`. */
  async noteWritten(dir: string, name: string, existing: Existing): Promise<void> {
    (await this.listing(dir)).set(name, existing);
  }

  /**
   * Make `dir` if it is missing, with its parents. One below the directory is looked at as itself,
   * after its parent: a softlink there is refused, never followed out of the directory.
   */
  async ensureDir(dir: string): Promise<void> {
    if (this.#made.has(dir)) return;
    const directory = this.directory;
    const inside = dir !== directory && dir.startsWith(directory === '/' ? '/' : `${directory}/`);
    if (inside) await this.ensureDir(dirname(dir));
    try {
      const node = await this.vfs.get(this.access, dir, { readlink: inside });
      if (node.type === NODE_TYPE_SOFTLINK) throw new Error(`${dir} is a softlink, which ${this.command} does not follow`);
      if (node.type !== NODE_TYPE_DIRECTORY) throw new Error(`${dir} is not a directory`);
    } catch (error) {
      if (!(error instanceof NodeNotFoundError)) throw error;
      if (!inside) await this.ensureDir(dirname(dir));
      await this.vfs.ensure(this.access, NODE_TYPE_DIRECTORY, dirname(dir), basename(dir));
      await this.noteWritten(dirname(dir), basename(dir), { type: NODE_TYPE_DIRECTORY, size: 0, written: true });
      this.directories++;
    }
    this.#made.add(dir);
  }

  /** Make the directory itself, refusing the expansion when it cannot be. */
  async ensureRoot(): Promise<void> {
    await this.ensureDir(this.directory).catch((error) => {
      throw new ExpandRefusedError(error instanceof Error ? error.message : String(error));
    });
  }

  /** Whether a file entry at `name` in `dir` may be written: not when a whole file is there already, unless `overwrite`. */
  async willWrite(dir: string, name: string, overwrite: boolean): Promise<boolean> {
    const existing = (await this.listing(dir)).get(name);
    return !existing?.written || overwrite;
  }

  /**
   * What to do with a file entry of `size` bytes at `name` in `dir`: a file already there at that
   * size is left alone, and one at another size is an error unless `overwrite`; a file whose write
   * never finished is written again. Throws, saying why, when something else is there.
   */
  async planFile(dir: string, name: string, size: number, overwrite: boolean): Promise<FilePlan> {
    const existing = (await this.listing(dir)).get(name);
    if (!existing) return 'create';
    if (existing.type !== NODE_TYPE_FILE) throw new Error(`a ${existing.type} is there`);
    if (existing.written && !overwrite) {
      if (existing.size !== size) throw new Error(`a file of another size is there (${humanizeSize(existing.size)}); ${this.overwriteFlag} writes over it`);
      return 'skip';
    }
    return 'write';
  }

  /** `writeStream` into `name` in `dir`, noting the file written. */
  async writeFile(
    dir: string,
    name: string,
    create: boolean,
    fill: (writable: WritableStream<Uint8Array>) => Promise<void>,
    opts: WriteOptions = {},
  ): Promise<void> {
    const size = await writeStream(this.vfs, this.access, dir, name, create, fill, opts);
    await this.noteWritten(dir, name, { type: NODE_TYPE_FILE, size, written: true });
  }
}

/**
 * Stream bytes into the file `name` in `dir`, creating it when `create`: `fill` writes them into the
 * stream it is given and settles when they are all written. The file is then given what the bytes
 * are (size, sha256, mimetype), as an upload records them, and what `opts` says. A file this call
 * created and could not fill is removed again, so a later run does not take a part for the whole.
 *
 * @returns the bytes written
 */
export const writeStream = async (
  vfs: NodeVFS,
  access: Access,
  dir: string,
  name: string,
  create: boolean,
  fill: (writable: WritableStream<Uint8Array>) => Promise<void>,
  opts: WriteOptions = {},
): Promise<number> => {
  const path = join(dir, name);
  if (create) {
    await vfs.create<FileAttrs>(access, NODE_TYPE_FILE, dir, name, {
      attrs: { name, mimetype: await getMimeFromExt(name), size: 0 },
    });
  }

  const collector = createFileAttrsCollector(name);
  try {
    const fh = await vfs.open(access, path, { mode: 'w' });
    try {
      const { readable, writable } = collector.stream;
      const stored = readable.pipeTo(fh.writable);
      try {
        await fill(writable);
      } catch (error) {
        // A filler that never took the stream leaves it to be aborted here, so the copy into the
        // file ends either way.
        if (!writable.locked) await writable.abort(error).catch(() => {});
        await stored.catch(() => {});
        throw error;
      }
      await stored;
    } finally {
      await fh.close();
    }
  } catch (error) {
    if (create) await vfs.unlink(access, path, dir).catch(() => {});
    throw error;
  }

  const computed = await collector.finalize();
  const frozen = !!opts.frozenUploads && freezes(opts.frozenUploads, computed.mimetype);
  const attrs = { ...computed, ...(opts.writtenAt ? { writtenAt: opts.writtenAt.toISOString() } : {}), ...(frozen ? { frozen } : {}) };
  await vfs.update<FileAttrs>(access, path, { attrs });
  return computed.size;
};

/**
 * Free bytes on the filesystem that holds the disk tier, read now. Undefined where no disk root
 * is published (a store held in memory), which leaves the space unchecked.
 */
export const diskFreeBytes = async (cmd: Command): Promise<number | undefined> => {
  const root = cmd.env.EIN_FILE_ROOT_PATH;
  if (!root) return undefined;
  const [sample] = await sampleDisk([{ tier: 'disk', path: root }]);
  return sample?.freeBytes;
};

/** The refusal of an expansion that writes `needed` bytes where `free` are, or undefined when they fit. */
export const spaceRefusal = (needed: number, free: number | undefined): ExpandRefusedError | undefined => {
  if (free === undefined || free >= needed * SPACE_FACTOR) return undefined;
  return new ExpandRefusedError(
    `not enough space: expanding writes ${humanizeSize(needed)}, which needs ${humanizeSize(needed * SPACE_FACTOR)} free, and ${humanizeSize(free)} is`,
  );
};
