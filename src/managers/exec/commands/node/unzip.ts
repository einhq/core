/**
 * unzip — expand a zip archive into a directory.
 *
 * The archive is read range by range through its VFS handle, and each entry is streamed from it
 * into its file node, so neither the archive nor an entry is ever held in memory: a multi-gigabyte
 * Takeout part costs its central directory and one read buffer. The entries are walked twice, once
 * to refuse the archive before anything is written (an entry that would land outside the
 * directory, or more bytes than the disk has room for) and once to write.
 *
 * An entry's file is created, its bytes written, and then given the size, sha256 and mimetype read
 * on the way through and the entry's modification time as `writtenAt`, as an upload records them.
 * With `--as-upload` the entries are taken for the upload they came in, and one of a type
 * `/etc/frozen-uploads` lists is frozen as an upload of it would be (ein/core#844).
 */

import { basename, dirname, join, resolve } from '@std/path';
import { configure, type Entry, ERR_UNSAFE_FILENAME, type FileEntry, Reader, ZipReader } from '@zip-js/zip-js';
import type { UnzipAnswer } from '../../../../lib/api/node.ts';
import type { Access } from '../../../../lib/access/mod.ts';
import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '../../../../lib/args/mod.ts';
import { createFileAttrsCollector } from '../../../../lib/media/file-attrs.ts';
import { freezes, type FrozenUploads, readFrozenUploads } from '../../../../lib/media/frozen-uploads.ts';
import { getMimeFromExt } from '../../../../lib/media/mime.ts';
import { sampleDisk } from '../../../../lib/metrics/disk.ts';
import { humanizeSize } from '../../../../lib/utils/humanize-size.ts';
import { type ResourceHandleIf, ResourceSeekMode } from '../../../../registries/types.ts';
import { NodeNotFoundError, type NodeVFS } from '../../../../vfs/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../../../vfs/types/directory.ts';
import { type FileAttrs, NODE_TYPE_FILE } from '../../../../vfs/types/file.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

// zip.js would run its codecs in web workers spawned from blob URLs; inflating on this thread
// through the runtime's DecompressionStream needs none, and a worker would outlive the command.
configure({ useWebWorkers: false });

/** The free space an expansion must find, as a multiple of the bytes it will write. */
export const SPACE_FACTOR = 1.1;

/** Children read per page when listing what a directory already holds. */
const LISTING_PAGE = 1000;

/**
 * An open VFS handle as zip.js's random-access source. zip.js may ask for several ranges at
 * once, and a handle has one position, so each seek and its reads wait for the read before.
 */
class HandleReader extends Reader<ResourceHandleIf> {
  #handle: ResourceHandleIf;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(handle: ResourceHandleIf) {
    super(handle);
    this.#handle = handle;
  }

  override async init(): Promise<void> {
    await super.init?.();
    this.size = await this.#handle.size();
  }

  override readUint8Array(offset: number, length: number): Promise<Uint8Array> {
    const result = this.#queue.then(async () => {
      await this.#handle.seek(offset, ResourceSeekMode.Start);
      const data = new Uint8Array(length);
      let filled = 0;
      while (filled < length) {
        const chunk = await this.#handle.read(length - filled);
        if (chunk.length === 0) break;
        data.set(chunk, filled);
        filled += chunk.length;
      }
      return filled === length ? data : data.subarray(0, filled);
    });
    this.#queue = result.catch(() => undefined);
    return result;
  }
}

/** Why an archive is not expanded at all: nothing has been written when this is thrown. */
export class UnzipRefusedError extends Error {}

type ExpandOptions = {
  /** Write over a file already there; otherwise one of the entry's size is left as it is. */
  overwrite: boolean;
  /** The types a written file is frozen by, as an upload is; none freezes nothing. */
  frozenUploads?: FrozenUploads;
  /** Free bytes where the files will be stored, or undefined when that cannot be measured. */
  freeBytes: () => Promise<number | undefined>;
  signal?: AbortSignal;
  /** Told of each entry that is not expanded, as it happens. */
  onFailed?: (failure: UnzipAnswer['failed'][number]) => Promise<void>;
};

/** A node already at an entry's path. `written` is false for a file whose last write never finished: no write recorded its sha256. */
type Existing = { type: string; size: number; written: boolean };

/**
 * Expand the zip at `archive` into `directory`, made if missing.
 *
 * An entry's path is split on `/` into names below `directory`; empty and `.` names are dropped.
 * zip.js refuses a name with a `..` component or an absolute one while the entries are listed,
 * which refuses the archive. So does more uncompressed bytes to write than the free space over
 * `SPACE_FACTOR`, counting only the files that will be written. A file already at an entry's path
 * is left alone at the entry's size (skipped, so a run that stopped goes on where it was), and at
 * another size it is an entry that failed, unless `overwrite`; a file whose write never finished is
 * written again. An entry that fails is reported in `failed` and the rest are still expanded.
 *
 * @throws UnzipRefusedError when the archive is refused, before anything is written
 */
export async function expandZip(vfs: NodeVFS, access: Access, archive: string, directory: string, opts: ExpandOptions): Promise<UnzipAnswer> {
  const answer: UnzipAnswer = { ok: true, archive, directory, files: 0, directories: 0, bytes: 0, skipped: 0, failed: [] };
  const fail = async (entry: string, error: unknown) => {
    const failure = { entry, error: error instanceof Error ? error.message : String(error) };
    answer.failed.push(failure);
    await opts.onFailed?.(failure);
  };

  // What each directory the entries reach holds, by name: read once per directory, kept up to
  // date as files are written, and empty for one that does not exist yet.
  const listings = new Map<string, Map<string, Existing>>();
  const listing = async (dir: string): Promise<Map<string, Existing>> => {
    let names = listings.get(dir);
    if (names) return names;
    names = new Map();
    try {
      let after: string | undefined;
      while (true) {
        const page = await vfs.children<FileAttrs>(access, dir, { page: { limit: LISTING_PAGE, after } });
        for (const child of page) {
          const { type, attrs } = child.node;
          names.set(child.name, { type, size: Number(attrs.size ?? 0), written: type !== NODE_TYPE_FILE || !!attrs.sha256 });
        }
        if (page.length < LISTING_PAGE) break;
        after = page[page.length - 1].name;
      }
    } catch (error) {
      if (!(error instanceof NodeNotFoundError)) throw error;
    }
    listings.set(dir, names);
    return names;
  };

  const target = (entry: Entry): { dir: string; name: string } | undefined => {
    const names = entry.filename.split('/').filter((name) => name !== '' && name !== '.');
    if (names.length === 0) return undefined;
    return { dir: join(directory, ...names.slice(0, -1)), name: names[names.length - 1] };
  };

  const handle = await vfs.open(access, archive, { mode: 'r' });
  const zip = new ZipReader(new HandleReader(handle), { filenameValidation: 'balanced' });
  try {
    // First pass: the names and the bytes, before anything is written.
    let needed = 0;
    try {
      for await (const entry of zip.getEntriesGenerator()) {
        if (entry.directory || entry.symlink) continue;
        const to = target(entry);
        if (!to) continue;
        const existing = (await listing(to.dir)).get(to.name);
        if (!existing?.written || opts.overwrite) needed += entry.uncompressedSize;
      }
    } catch (error) {
      if (error instanceof Error && error.message === ERR_UNSAFE_FILENAME) {
        const name = (error as Error & { filename?: string }).filename;
        throw new UnzipRefusedError(`refusing entry '${name}': it would land outside ${directory}`);
      }
      throw new UnzipRefusedError(`cannot read ${archive}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const free = await opts.freeBytes();
    if (free !== undefined && free < needed * SPACE_FACTOR) {
      throw new UnzipRefusedError(
        `not enough space: expanding writes ${humanizeSize(needed)}, which needs ${humanizeSize(needed * SPACE_FACTOR)} free, and ${humanizeSize(free)} is`,
      );
    }

    // The directories known to exist, so each is looked up or made once.
    const made = new Set<string>();
    const ensureDir = async (dir: string): Promise<void> => {
      if (made.has(dir)) return;
      try {
        const node = await vfs.get(access, dir);
        if (node.type !== NODE_TYPE_DIRECTORY) throw new Error(`${dir} is not a directory`);
      } catch (error) {
        if (!(error instanceof NodeNotFoundError)) throw error;
        await ensureDir(dirname(dir));
        await vfs.ensure(access, NODE_TYPE_DIRECTORY, dirname(dir), basename(dir));
        (await listing(dirname(dir))).set(basename(dir), { type: NODE_TYPE_DIRECTORY, size: 0, written: true });
        answer.directories++;
      }
      made.add(dir);
    };

    await ensureDir(directory).catch((error) => {
      throw new UnzipRefusedError(error instanceof Error ? error.message : String(error));
    });

    // Second pass: write.
    for await (const entry of zip.getEntriesGenerator()) {
      if (opts.signal?.aborted) break;
      const to = target(entry);
      if (!to) continue;
      try {
        if (entry.directory) {
          await ensureDir(join(to.dir, to.name));
          continue;
        }
        if (entry.symlink) throw new Error('a symbolic link, not expanded');

        await ensureDir(to.dir);
        const names = await listing(to.dir);
        const existing = names.get(to.name);
        if (existing && existing.type !== NODE_TYPE_FILE) throw new Error(`a ${existing.type} is there`);
        if (existing?.written && !opts.overwrite) {
          if (existing.size !== entry.uncompressedSize) throw new Error(`a file of another size is there (${humanizeSize(existing.size)}); -o writes over it`);
          answer.skipped++;
          continue;
        }

        await writeEntry(vfs, access, entry, to.dir, to.name, !existing, opts.frozenUploads, opts.signal);
        names.set(to.name, { type: NODE_TYPE_FILE, size: entry.uncompressedSize, written: true });
        answer.files++;
        answer.bytes += entry.uncompressedSize;
      } catch (error) {
        await fail(entry.filename, error);
      }
    }
  } finally {
    await zip.close().catch(() => {});
    await handle.close().catch(() => {});
  }

  answer.ok = answer.failed.length === 0;
  return answer;
}

/**
 * Stream one entry into the file `name` in `dir`, creating it when `create`, and record what the
 * bytes are, freezing it when `frozenUploads` lists their type. A file this call created and could
 * not fill is removed again, so a later run does not take a part for the whole.
 */
async function writeEntry(
  vfs: NodeVFS,
  access: Access,
  entry: FileEntry,
  dir: string,
  name: string,
  create: boolean,
  frozenUploads: FrozenUploads | undefined,
  signal?: AbortSignal,
): Promise<void> {
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
        await entry.getData(writable, { checkCrc32: true, signal });
      } catch (error) {
        // zip.js aborts the stream it was writing; one it never took is aborted here, so the
        // copy into the file ends either way.
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
  const frozen = !!frozenUploads && freezes(frozenUploads, computed.mimetype);
  await vfs.update<FileAttrs>(access, path, {
    attrs: { ...computed, writtenAt: entry.lastModDate.toISOString(), ...(frozen ? { frozen } : {}) },
  });
}

/**
 * Free bytes on the filesystem that holds the disk tier, read now. Undefined where no disk root
 * is published (a store held in memory), which leaves the space unchecked.
 */
const diskFreeBytes = async (cmd: Command): Promise<number | undefined> => {
  const root = cmd.env.EIN_FILE_ROOT_PATH;
  if (!root) return undefined;
  const [sample] = await sampleDisk([{ tier: 'disk', path: root }]);
  return sample?.freeBytes;
};

export const unzip = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, {
    boolean: ['n', 'o', 'as-upload'],
    string: ['d'],
    unknown: collectUnknownFlags(unknown),
  });
  if (await reportUnknownFlags(cmd, unknown)) return 1;

  const args = flags._;
  if (args.length !== 1) {
    await cmd.writeError('unzip: expected one archive\nUsage: unzip [-n | -o] [--as-upload] [-d DIR] ARCHIVE\n');
    return 1;
  }
  if (flags.n && flags.o) {
    await cmd.writeError('unzip: -n and -o cannot both be given\n');
    return 1;
  }

  const archive = resolve(cmd.cwd, args[0]);
  const directory = resolve(cmd.cwd, flags.d ?? '.');

  if (!cmd.env.EIN_FILE_ROOT_PATH) await cmd.writeError('unzip: free space not checked: no disk tier root is published\n');

  let answer: UnzipAnswer;
  try {
    answer = await expandZip(cmd.sys.vfs, cmd.access, archive, directory, {
      overwrite: flags.o,
      frozenUploads: flags['as-upload'] ? await readFrozenUploads(cmd.sys.vfs) : undefined,
      freeBytes: () => diskFreeBytes(cmd),
      signal: cmd.interruptSignal,
      onFailed: (failure) => cmd.writeError(`unzip: ${failure.entry}: ${failure.error}\n`),
    });
  } catch (error) {
    await cmd.writeError(`unzip: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (cmd.interruptSignal.aborted) {
    await cmd.writeError('unzip: interrupted\n');
    return 1;
  }

  if (cmd.json) {
    await cmd.writeJSON(answer satisfies UnzipAnswer);
  } else {
    const skipped = answer.skipped > 0 ? `, ${answer.skipped} already there` : '';
    const failed = answer.failed.length > 0 ? `, ${answer.failed.length} failed` : '';
    await cmd.writeLn(
      `${answer.files} files (${humanizeSize(answer.bytes)}) and ${answer.directories} directories into ${answer.directory}${skipped}${failed}`,
    );
  }
  // An entry not expanded fails the command, so `unzip … && rm <archive>` keeps the archive.
  return answer.ok ? 0 : 1;
};

unzip.spec = {
  name: 'unzip',
  effect: 'write' as const,
  description:
    'Expand a zip archive into a directory, streaming each entry. Refuses an archive with an entry that would land outside the directory, or whose files would not leave a tenth of their size free. A file already there at its entry’s size is left as it is, so a run that stopped can be run again',
  args: [
    { name: 'archive', type: 'path' as const, description: 'the zip to expand' },
  ],
  flags: [
    { name: 'd', type: 'path' as const, description: 'the directory to expand into, made if missing (default: the current one)' },
    { name: 'n', type: 'bool' as const, description: 'never write over an existing file (the default)' },
    { name: 'o', type: 'bool' as const, description: 'write over an existing file' },
    {
      name: 'as-upload',
      type: 'bool' as const,
      description: 'take the files for the upload the archive came in: one of a type /etc/frozen-uploads lists is frozen, as an upload of it would be',
    },
  ],
  examples: [
    'unzip -d /home/anna/staging/files/inbox /home/anna/staging/files/inbox/takeout-001.zip',
    'unzip --as-upload -d /home/anna/staging/files/inbox /home/anna/staging/files/inbox/takeout-001.zip',
  ],
  returns:
    'in JSON mode, UnzipAnswer: the files, directories and bytes written, the files left as they were, and each entry not expanded with why. Exits non-zero when any entry was not expanded.',
};
