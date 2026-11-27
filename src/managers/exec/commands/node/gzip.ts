/**
 * gzip and gunzip — compress a file into FILE.gz, or back, streaming its bytes.
 *
 * As gzip(1): each FILE is replaced by its compressed or decompressed copy unless `-k`, `-c` writes
 * to stdout instead, and with no FILE, or `-`, stdin goes to stdout. A copy is written as an upload
 * is, with what its bytes are recorded, and one that could not be finished is removed.
 */

import { basename, dirname, resolve } from '@std/path';
import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '../../../../lib/args/mod.ts';
import { gunzipStream, gzipStream } from '../../../../lib/archive/gzip.ts';
import { NodeNotFoundError } from '../../../../vfs/mod.ts';
import { NODE_TYPE_FILE } from '../../../../vfs/types/file.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { writeStream } from './expand.ts';

/** Bytes read from a file at a time. */
const READ_CHUNK = 256 * 1024;

const LEVELS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** What a decompressed copy of `name` is called, or undefined for a name gzip does not know. */
const decompressedName = (name: string): string | undefined => {
  if (/\.tgz$/i.test(name)) return name.slice(0, -4) + '.tar';
  if (/\.gz$/i.test(name) && name.length > 3) return name.slice(0, -3);
  return undefined;
};

/** The bytes of the file at `path`, as a stream that closes the file when it ends or is cancelled. */
const fileStream = async (cmd: Command, path: string): Promise<ReadableStream<Uint8Array>> => {
  const node = await cmd.sys.vfs.get(cmd.access, path);
  if (node.type !== NODE_TYPE_FILE) throw new Error(`a ${node.type}, not a file`);
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
};

/** Write a stream's bytes to stdout. */
const toStdout = async (cmd: Command, stream: ReadableStream<Uint8Array>): Promise<void> => {
  for await (const chunk of stream) {
    if (cmd.interrupted) {
      await stream.cancel().catch(() => {});
      return;
    }
    await cmd.write(chunk);
  }
};

const run = async (cmd: Command, decompress: boolean): CmdReturn => {
  const name = cmd.name;
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, {
    boolean: ['d', 'c', 'k', 'f', ...LEVELS],
    alias: { d: 'decompress', c: 'stdout', k: 'keep', f: 'force' },
    unknown: collectUnknownFlags(unknown),
  });
  if (await reportUnknownFlags(cmd, unknown)) return 1;

  decompress ||= !!flags.d;
  const level = LEVELS.findLast((digit) => flags[digit]);
  const transform = () => decompress ? gunzipStream() : gzipStream(level ? Number(level) : undefined);
  const files = flags._.length > 0 ? flags._ : ['-'];

  if (!decompress && cmd.tty && !flags.f && (flags.c || files.includes('-'))) {
    await cmd.writeError(`${name}: compressed data not written to a terminal; -f writes it anyway\n`);
    return 1;
  }

  let failed = false;
  const fail = async (file: string, why: unknown) => {
    failed = true;
    await cmd.writeError(`${name}: ${file}: ${why instanceof Error ? why.message : String(why)}\n`);
  };

  for (const file of files) {
    if (cmd.interrupted) break;
    try {
      if (file === '-') {
        await toStdout(cmd, ReadableStream.from(cmd.stdin.chunks()).pipeThrough(transform()));
        continue;
      }
      const path = resolve(cmd.cwd, file);
      if (flags.c) {
        await toStdout(cmd, (await fileStream(cmd, path)).pipeThrough(transform()));
        continue;
      }

      const outName = decompress ? decompressedName(basename(path)) : `${basename(path)}.gz`;
      if (!outName) throw new Error('unknown suffix, left as it is');
      if (!decompress && /\.(gz|tgz)$/i.test(path)) throw new Error('already has a .gz suffix, left as it is');
      const dir = dirname(path);
      const input = await fileStream(cmd, path);

      let exists = true;
      try {
        await cmd.sys.vfs.get(cmd.access, resolve(dir, outName), { readlink: true });
      } catch (error) {
        if (!(error instanceof NodeNotFoundError)) throw error;
        exists = false;
      }
      if (exists && !flags.f) {
        await input.cancel();
        throw new Error(`${outName} already exists; -f writes over it`);
      }

      await writeStream(cmd.sys.vfs, cmd.access, dir, outName, !exists, (writable) => input.pipeThrough(transform()).pipeTo(writable, { signal: cmd.interruptSignal }));
      if (!flags.k) await cmd.sys.vfs.unlink(cmd.access, path, dir);
    } catch (error) {
      if (cmd.interrupted) break;
      await fail(file, error);
    }
  }

  if (cmd.interrupted) return 130;
  return failed ? 1 : 0;
};

export const gzip = (cmd: Command): CmdReturn => run(cmd, false);
export const gunzip = (cmd: Command): CmdReturn => run(cmd, true);

const flagSpecs = [
  { name: 'c', type: 'bool' as const, description: 'write to stdout and leave the files as they are' },
  { name: 'k', type: 'bool' as const, description: 'keep each file beside its copy' },
  { name: 'f', type: 'bool' as const, description: 'write over a copy already there; with gzip, write compressed data to a terminal' },
];

gzip.spec = {
  name: 'gzip',
  effect: 'write' as const,
  json: false,
  description:
    'Compress each file into FILE.gz, removing the file unless -k, or decompress it with -d; with no file, or -, stdin to stdout. Streams the bytes, so a file of any size takes little memory',
  args: [
    { name: 'file', type: 'path' as const, description: 'a file to compress or decompress (default: stdin to stdout)', optional: true, variadic: true },
  ],
  flags: [
    { name: 'd', type: 'bool' as const, description: 'decompress, as gunzip does' },
    ...flagSpecs,
    { name: '1', type: 'bool' as const, description: 'compress fastest; -2 to -9 compress better, -9 best (default -6)' },
  ],
  examples: [
    'gzip -k /home/anna/notes/journal.txt',
    'cat /home/anna/notes/journal.txt | gzip > /home/anna/notes/journal.txt.gz',
  ],
};

gunzip.spec = {
  name: 'gunzip',
  effect: 'write' as const,
  json: false,
  description:
    'Decompress each FILE.gz into FILE (FILE.tgz into FILE.tar), removing it unless -k; with no file, or -, stdin to stdout. Reads several gzip members one after another, and zeros after the last, as one stream',
  args: [
    { name: 'file', type: 'path' as const, description: 'a .gz or .tgz file to decompress (default: stdin to stdout)', optional: true, variadic: true },
  ],
  flags: flagSpecs,
  examples: [
    'gunzip /home/anna/downloads/maps.tar.gz',
    'gunzip -c /home/anna/logs/old.log.gz | grep error',
  ],
};
