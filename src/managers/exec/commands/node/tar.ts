/**
 * tar — list or expand a tar archive, gzip-compressed or not.
 *
 * The archive is read as a stream, from a file or from stdin, and each entry's bytes are streamed
 * into its file node, so neither the archive nor an entry is held in memory. A compressed archive is
 * known by its first bytes, with or without `-z`.
 *
 * Expanding follows `unzip`'s rules. An archive in a file is read twice: once to refuse it before
 * anything is written (an entry that would land outside the directory, or more bytes than the disk
 * has room for), and once to write. One read from stdin can be read once only: such an entry fails
 * on its own, and the space is checked file by file against what was free when it started. A file
 * already there at its entry's size is left as it is, so a run that stopped goes on where it was.
 * Softlinks are made as softlinks, and a hard link as a link to the node an earlier entry made; a
 * softlink below the directory is never followed. Devices, fifos and sparse files are not expanded.
 */

import { join, resolve } from '@std/path';
import type { TarAnswer, TarListEntry } from '../../../../lib/api/node.ts';
import type { Access } from '../../../../lib/access/mod.ts';
import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '../../../../lib/args/mod.ts';
import { gunzipStream, peekGzip } from '../../../../lib/archive/gzip.ts';
import { readTar, type TarEntry } from '../../../../lib/archive/tar.ts';
import { humanizeSize } from '../../../../lib/utils/humanize-size.ts';
import type { NodeVFS } from '../../../../vfs/mod.ts';
import { NODE_TYPE_FILE } from '../../../../vfs/types/file.ts';
import { NODE_TYPE_SOFTLINK } from '../../../../vfs/types/softlink.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { diskFreeBytes, entryNames, ExpandRefusedError, Expansion, SPACE_FACTOR, spaceRefusal } from './expand.ts';

/** Bytes read from an archive's file at a time. */
const READ_CHUNK = 256 * 1024;

/** A path's names, with empty and `.` names dropped: how an entry and a name given are compared. */
const namesOf = (path: string): string[] => path.split('/').filter((name) => name !== '' && name !== '.');

/** Which entries the names given select: all of them when none is given, else each named and everything under it. */
class Selection {
  #members: { name: string; names: string[]; matched: boolean }[];

  constructor(members: string[]) {
    this.#members = members.map((name) => ({ name, names: namesOf(name), matched: false }));
  }

  /** Whether the entry at `path` is selected; the names that select it count as found. */
  has(path: string): boolean {
    if (this.#members.length === 0) return true;
    const names = namesOf(path);
    let selected = false;
    for (const member of this.#members) {
      if (member.names.length <= names.length && member.names.every((name, i) => name === names[i])) {
        member.matched = true;
        selected = true;
      }
    }
    return selected;
  }

  /** The names given that no entry matched. */
  get missing(): string[] {
    return this.#members.filter((member) => !member.matched).map((member) => member.name);
  }
}

/** Where an archive's bytes come from: opened again for each read when it is a file. */
type TarSource = {
  /** The archive's path, or `-` for stdin. */
  name: string;
  /** The archive's bytes from the start. */
  open(): Promise<ReadableStream<Uint8Array>>;
  /** Whether `open` can be called more than once. */
  rereadable: boolean;
};

/** The entries of the archive `source` holds, decompressed when it is gzip; `gzip` says it must be. */
const entriesOf = async (source: TarSource, gzip: boolean): Promise<AsyncGenerator<TarEntry>> => {
  const peeked = await peekGzip(await source.open());
  if (gzip && !peeked.gzip) {
    await peeked.stream.cancel();
    throw new Error(`${source.name} is not in gzip format`);
  }
  return readTar(peeked.gzip ? peeked.stream.pipeThrough(gunzipStream()) : peeked.stream);
};

type ExpandOptions = {
  /** Expand only the entries these name, and what is under them; all when empty. */
  members: string[];
  /** Leading names dropped from each entry's path; an entry with no more names than that is passed over. */
  strip: number;
  /** The archive must be gzip; otherwise it is decompressed when it is. */
  gzip: boolean;
  /** Write over a file already there; otherwise one of the entry's size is left as it is. */
  overwrite: boolean;
  /** Free bytes where the files will be stored, or undefined when that cannot be measured. */
  freeBytes: () => Promise<number | undefined>;
  signal?: AbortSignal;
  /** Told of each entry as it is expanded. */
  onEntry?: (path: string) => Promise<void>;
  /** Told of each entry that is not expanded, as it happens. */
  onFailed?: (failure: TarAnswer['failed'][number]) => Promise<void>;
};

/** Why an entry of this kind is not expanded. */
const NOT_EXPANDED: Record<string, string> = {
  '3': 'a character device',
  '4': 'a block device',
  '6': 'a fifo',
  'S': 'a sparse file',
};

/**
 * Expand the tar archive `source` holds into `directory`, made if missing.
 *
 * An entry's path, its first `strip` names dropped, names where it lands below `directory`. An
 * absolute path, or one with a `..` name, would land outside it: when the archive can be read twice
 * that refuses it, and otherwise that entry fails. So does more bytes to write than the free space
 * over `SPACE_FACTOR`. A file already at an entry's path is left alone at the entry's size, and at
 * another size it is an entry that failed, unless `overwrite`. An entry that fails is reported in
 * `failed` and the rest are still expanded, and so is each name in `members` no entry matched.
 *
 * @throws ExpandRefusedError when the archive is refused, before anything is written
 * @throws Error when the archive cannot be read part way through
 */
export async function expandTar(vfs: NodeVFS, access: Access, source: TarSource, directory: string, opts: ExpandOptions): Promise<TarAnswer> {
  const answer: TarAnswer = { ok: true, archive: source.name, directory, files: 0, directories: 0, links: 0, bytes: 0, skipped: 0, failed: [] };
  const fail = async (entry: string, error: unknown) => {
    const failure = { entry, error: error instanceof Error ? error.message : String(error) };
    answer.failed.push(failure);
    await opts.onFailed?.(failure);
  };

  const expansion = new Expansion(vfs, access, directory, 'tar', '--overwrite');
  /** The names below `directory` the entry at `path` lands at, or undefined when it would land outside; [] for none. */
  const landing = (path: string): string[] | undefined => entryNames(path)?.slice(opts.strip);
  const outside = () => new Error(`it would land outside ${directory}`);

  // The free space the files of a single read are checked against as they are written.
  let free: number | undefined;
  if (source.rereadable) {
    // First pass: the names and the bytes, before anything is written.
    let needed = 0;
    const selection = new Selection(opts.members);
    try {
      for await (const entry of await entriesOf(source, opts.gzip)) {
        if (!selection.has(entry.path)) continue;
        const names = landing(entry.path);
        const link = entry.kind === 'hardlink' ? landing(entry.linkname) : [];
        if (!names || !link) throw new ExpandRefusedError(`refusing entry '${entry.path}': it would land outside ${directory}`);
        const to = expansion.target(names);
        if (to && entry.kind === 'file' && await expansion.willWrite(to.dir, to.name, opts.overwrite)) needed += entry.size;
      }
    } catch (error) {
      if (error instanceof ExpandRefusedError) throw error;
      throw new ExpandRefusedError(`cannot read ${source.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const refusal = spaceRefusal(needed, await opts.freeBytes());
    if (refusal) throw refusal;
  } else {
    free = await opts.freeBytes();
  }
  await expansion.ensureRoot();

  // Second pass: write.
  const selection = new Selection(opts.members);
  let written = 0;
  for await (const entry of await entriesOf(source, opts.gzip)) {
    if (opts.signal?.aborted) break;
    if (!selection.has(entry.path)) continue;
    try {
      const names = landing(entry.path);
      if (!names) throw outside();
      const to = expansion.target(names);
      if (!to) continue;
      if (entry.typeflag === 'V') continue;
      await opts.onEntry?.(entry.path);

      switch (entry.kind) {
        case 'directory':
          await expansion.ensureDir(join(to.dir, to.name));
          break;

        case 'file': {
          await expansion.ensureDir(to.dir);
          const plan = await expansion.planFile(to.dir, to.name, entry.size, opts.overwrite);
          if (plan === 'skip') {
            answer.skipped++;
            break;
          }
          if (free !== undefined && free < (written + entry.size) * SPACE_FACTOR) {
            throw new Error(`not enough space: with this file the expansion writes ${humanizeSize(written + entry.size)}, and ${humanizeSize(free)} was free`);
          }
          await expansion.writeFile(to.dir, to.name, plan === 'create', (writable) => ReadableStream.from(entry.body()).pipeTo(writable, { signal: opts.signal }), {
            writtenAt: entry.mtime,
          });
          written += entry.size;
          answer.files++;
          answer.bytes += entry.size;
          break;
        }

        case 'symlink': {
          await expansion.ensureDir(to.dir);
          if (await linkThere(vfs, access, expansion, to.dir, to.name, entry.linkname, opts.overwrite)) {
            answer.skipped++;
            break;
          }
          await vfs.create(access, NODE_TYPE_SOFTLINK, to.dir, to.name, {
            props: { uid: access.uid, gid: access.gid, mode: 0o777, softlink: entry.linkname },
          });
          await expansion.noteWritten(to.dir, to.name, { type: NODE_TYPE_SOFTLINK, size: 0, written: true });
          answer.links++;
          break;
        }

        case 'hardlink': {
          const target = landing(entry.linkname);
          if (!target) throw outside();
          const from = expansion.target(target);
          if (!from) throw new Error(`a hard link to ${directory} itself`);
          const fromPath = join(from.dir, from.name);
          const linked = (await expansion.listing(from.dir)).get(from.name);
          if (!linked) throw new Error(`a hard link to ${entry.linkname}, which is not there`);
          await expansion.ensureDir(to.dir);
          const existing = (await expansion.listing(to.dir)).get(to.name);
          if (existing) {
            if (existing.type === linked.type && existing.size === linked.size && !opts.overwrite) {
              answer.skipped++;
              break;
            }
            if (!opts.overwrite) throw new Error(`a ${existing.type} is there; --overwrite writes over it`);
            await vfs.unlink(access, join(to.dir, to.name), to.dir, { readlink: true });
          }
          await vfs.link(access, fromPath, to.dir, to.name);
          await expansion.noteWritten(to.dir, to.name, linked);
          answer.links++;
          break;
        }

        default:
          throw new Error(`${NOT_EXPANDED[entry.typeflag] ?? `an entry of type '${entry.typeflag}'`}, not expanded`);
      }
    } catch (error) {
      if (opts.signal?.aborted) break;
      await fail(entry.path, error);
    }
  }

  if (!opts.signal?.aborted) {
    for (const name of selection.missing) await fail(name, new Error('not found in the archive'));
  }
  answer.directories = expansion.directories;
  answer.ok = answer.failed.length === 0;
  return answer;
}

/**
 * Whether the softlink `name` in `dir` is there already, pointing at `target`. Something else there
 * is an error, unless `overwrite`, which removes it.
 */
const linkThere = async (
  vfs: NodeVFS,
  access: Access,
  expansion: Expansion,
  dir: string,
  name: string,
  target: string,
  overwrite: boolean,
): Promise<boolean> => {
  const existing = (await expansion.listing(dir)).get(name);
  if (!existing) return false;
  const path = join(dir, name);
  if (existing.type === NODE_TYPE_SOFTLINK) {
    const link = await vfs.get(access, path, { readlink: true });
    if (link.props.softlink === target) return true;
  }
  if (!overwrite) {
    const what = existing.type === NODE_TYPE_SOFTLINK ? 'a softlink elsewhere' : `a ${existing.type}`;
    throw new Error(`${what} is there; --overwrite writes over it`);
  }
  if (existing.type !== NODE_TYPE_SOFTLINK && existing.type !== NODE_TYPE_FILE) throw new Error(`a ${existing.type} is there`);
  await vfs.unlink(access, path, dir, { readlink: true });
  return false;
};

/** `-rw-r--r--` for a mode and the entry's kind. */
const modeString = (entry: TarEntry): string => {
  const kind = { directory: 'd', symlink: 'l', hardlink: 'h', file: '-', other: '?' }[entry.kind];
  const bits = 'rwxrwxrwx'.split('').map((letter, i) => (entry.mode & (0o400 >> i)) ? letter : '-').join('');
  return kind + bits;
};

/** One line of `tar -tv`: mode, size, time (UTC) and path, with where a link points. */
const longLine = (entry: TarEntry): string => {
  const time = entry.mtime.toISOString().slice(0, 16).replace('T', ' ');
  const link = entry.kind === 'symlink' ? ` -> ${entry.linkname}` : entry.kind === 'hardlink' ? ` link to ${entry.linkname}` : '';
  return `${modeString(entry)} ${String(entry.size).padStart(10)} ${time} ${entry.path}${link}`;
};

/** The archive `-f` names, or stdin. */
const sourceOf = (cmd: Command, archive: string | undefined): TarSource => {
  if (archive === undefined || archive === '-') {
    return { name: '-', rereadable: false, open: () => Promise.resolve(ReadableStream.from(cmd.stdin.chunks())) };
  }
  const path = resolve(cmd.cwd, archive);
  return {
    name: path,
    rereadable: true,
    open: async () => {
      const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'r' });
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          const chunk = await handle.read(READ_CHUNK);
          if (chunk.length > 0) return controller.enqueue(chunk);
          controller.close();
          await handle.close();
        },
        cancel: () => handle.close(),
      });
    },
  };
};

/** Old-style options, `tar xzf ARCHIVE`: the first word without a dash, made `-xzf`. */
const withDash = (args: string[]): string[] => args.length > 0 && /^[A-Za-z]*[xt][A-Za-z]*$/.test(args[0]) ? [`-${args[0]}`, ...args.slice(1)] : args;

const USAGE = 'Usage: tar -x|-t [-z] [-v] [-O] [-f ARCHIVE] [-C DIR] [--strip-components N] [--overwrite] [MEMBER...]\n';

export const tar = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(withDash(cmd.args), {
    boolean: ['x', 't', 'z', 'v', 'O', 'overwrite'],
    string: ['f', 'C', 'strip-components'],
    alias: { x: 'extract', t: 'list', z: ['gzip', 'gunzip'], v: 'verbose', O: 'to-stdout', f: 'file', C: 'directory' },
    unknown: collectUnknownFlags(unknown),
  });
  if (await reportUnknownFlags(cmd, unknown)) return 1;

  if (flags.x === flags.t) {
    await cmd.writeError(`tar: give one of -x and -t\n${USAGE}`);
    return 1;
  }
  const strip = flags['strip-components'] === undefined ? 0 : Number(flags['strip-components']);
  if (!Number.isInteger(strip) || strip < 0) {
    await cmd.writeError(`tar: --strip-components takes a whole number, not '${flags['strip-components']}'\n`);
    return 1;
  }

  const source = sourceOf(cmd, flags.f);
  const members = flags._;
  const selection = new Selection(members);

  // -t lists, and -xO writes the files' bytes to stdout: neither writes a node.
  if (flags.t || flags.O) {
    const listed: TarListEntry[] = [];
    try {
      for await (const entry of await entriesOf(source, flags.z)) {
        if (cmd.interrupted) break;
        if (!selection.has(entry.path)) continue;
        if (flags.O) {
          if (entry.kind !== 'file') continue;
          if (flags.v) await cmd.writeError(`${entry.path}\n`);
          for await (const chunk of entry.body()) await cmd.write(chunk);
        } else if (cmd.json) {
          listed.push({
            path: entry.path,
            type: entry.kind,
            size: entry.size,
            mode: entry.mode & 0o7777,
            mtime: entry.mtime.toISOString(),
            ...(entry.linkname ? { linkname: entry.linkname } : {}),
          });
        } else {
          await cmd.writeLn(flags.v ? longLine(entry) : entry.path);
        }
      }
    } catch (error) {
      await cmd.writeError(`tar: ${source.name}: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    if (cmd.interrupted) return 130;
    if (cmd.json && !flags.O) await cmd.writeJSON(listed satisfies TarListEntry[]);
    for (const name of selection.missing) await cmd.writeError(`tar: ${name}: not found in the archive\n`);
    return selection.missing.length > 0 ? 1 : 0;
  }

  const directory = resolve(cmd.cwd, flags.C ?? '.');
  if (!cmd.env.EIN_FILE_ROOT_PATH) await cmd.writeError('tar: free space not checked: no disk tier root is published\n');

  let answer: TarAnswer;
  try {
    answer = await expandTar(cmd.sys.vfs, cmd.access, source, directory, {
      members,
      strip,
      gzip: flags.z,
      overwrite: flags.overwrite,
      freeBytes: () => diskFreeBytes(cmd),
      signal: cmd.interruptSignal,
      onEntry: flags.v && !cmd.json ? (path) => cmd.writeLn(path) : undefined,
      onFailed: (failure) => cmd.writeError(`tar: ${failure.entry}: ${failure.error}\n`),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`tar: ${error instanceof ExpandRefusedError ? message : `${source.name}: ${message}`}\n`);
    return 1;
  }

  if (cmd.interruptSignal.aborted) {
    await cmd.writeError('tar: interrupted\n');
    return 130;
  }
  if (cmd.json) await cmd.writeJSON(answer satisfies TarAnswer);
  // An entry not expanded fails the command, so `tar -xf … && rm <archive>` keeps the archive.
  return answer.ok ? 0 : 1;
};

tar.spec = {
  name: 'tar',
  effect: 'read' as const,
  description:
    'List (-t) or expand (-x) a tar archive, gzip-compressed or not, streaming each entry. Expanding refuses an archive with an entry that would land outside the directory, or whose files would not leave a tenth of their size free. A softlink below the directory is not followed. A file already there at its entry’s size is left as it is, so a run that stopped can be run again. Softlinks and hard links are made as links; devices and fifos are not expanded',
  args: [
    { name: 'member', type: 'path' as const, description: 'an entry to list or expand, with everything under it (default: all of them)', optional: true, variadic: true },
  ],
  flags: [
    { name: 'x', type: 'bool' as const, description: 'expand the archive', writes: true },
    { name: 't', type: 'bool' as const, description: 'list what the archive holds' },
    { name: 'f', type: 'path' as const, description: 'the archive, - for stdin (default: stdin)' },
    { name: 'z', type: 'bool' as const, description: 'the archive is gzip-compressed (known by its first bytes without it too)' },
    { name: 'C', type: 'path' as const, description: 'the directory to expand into, made if missing (default: the current one)' },
    { name: 'strip-components', type: 'number' as const, description: 'drop this many leading names from each entry’s path; an entry with no more is passed over' },
    { name: 'O', type: 'bool' as const, description: 'with -x, write the files’ bytes to stdout instead of expanding them' },
    { name: 'v', type: 'bool' as const, description: 'name each entry as it is expanded; with -t, list mode, size and time too' },
    { name: 'overwrite', type: 'bool' as const, description: 'write over a file or link already there' },
  ],
  examples: [
    'tar -xzf /home/anna/downloads/game-1.2.tar.gz -C /home/anna/games',
    'tar -tvf /home/anna/downloads/backup.tar',
    'tail -c +5469 /home/anna/downloads/installer.gz.sh | tar -xz -C /home/anna/game --strip-components 1 data/levels',
  ],
  returns:
    'with -x in JSON mode, TarAnswer: the files, directories, links and bytes written, the ones left as they were, and each entry not expanded with why; with -t, a TarListEntry per entry. Exits non-zero when any entry was not expanded or a name given matched none.',
};
