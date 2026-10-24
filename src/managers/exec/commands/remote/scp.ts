/**
 * `scp`: copy files between the EiN tree and another machine, over SFTP (as
 * OpenSSH's scp does by default). One side is remote (`[user@]host:path`), the
 * other is a path in the VFS.
 *
 * A file copied in is written the way an upload is — size, checksum and type
 * recorded afterwards — so the media pipelines take it in. A directory copied
 * out carries only files and directories: a photo's own children (metadata,
 * thumbnails) and links (people, locations) stay behind.
 */

import { basename, globToRegExp, resolve } from '@std/path';
import * as posix from '@std/path/posix';
import type { Client, FileAttributes, SFTP } from 'ssh2';
import { createFileAttrsCollector } from '../../../../lib/media/file-attrs.ts';
import { humanizeSize } from '../../../../lib/utils/humanize-size.ts';
import { connectSsh, parseScpOperand, type ScpOperand, sftpKind, sftpReadable, sftpWritable, SshConnectError } from '../../../../lib/ssh/mod.ts';
import { NodeNotFoundError } from '../../../../vfs/errors.ts';
import { NODE_TYPE_DIRECTORY } from '../../../../vfs/types/directory.ts';
import { contentTime, type FileAttrs, NODE_TYPE_FILE } from '../../../../vfs/types/file.ts';
import { NODE_TYPE_SOFTLINK } from '../../../../vfs/types/softlink.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { applySshOption, checkSshAllowed, connectOptions, hostSettings, parsePort, type SshConfigOptions, sshUserFromCommand } from './options.ts';

interface ScpArgs {
  config: SshConfigOptions;
  /** -F: the config file instead of ~/.ssh/config */
  configFile?: string;
  recursive: boolean;
  preserve: boolean;
  quiet: boolean;
  operands: string[];
}

const VALUE_FLAGS = new Set(['P', 'i', 'o', 'l', 'F']);

function parseScpArgs(args: string[]): ScpArgs {
  const config: SshConfigOptions = {};
  let configFile: string | undefined;
  let recursive = false;
  let preserve = false;
  let quiet = false;
  const operands: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      operands.push(arg);
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const letter = arg[j];
      if (VALUE_FLAGS.has(letter)) {
        const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i];
        if (value === undefined) throw new Error(`option requires an argument -- ${letter}`);
        if (letter === 'P') config.port = parsePort(value);
        else if (letter === 'i') config.identity = value;
        else if (letter === 'l') continue; // bandwidth limit: accepted, not applied
        else if (letter === 'F') configFile = value;
        else applySshOption(config, value);
        break;
      }
      if (letter === 'r') recursive = true;
      else if (letter === 'p') preserve = true;
      else if (letter === 'q') quiet = true;
      else if (letter === 'B') config.batchMode = true;
      else throw new Error(`unknown option -- ${letter}`);
    }
  }

  return { config, configFile, recursive, preserve, quiet, operands };
}

/** A one-line progress meter on the terminal, redrawn at most every 250 ms */
class Progress {
  private started = Date.now();
  private drawn = 0;
  private done = 0;

  constructor(private cmd: Command, private name: string, private size: number, private enabled: boolean) {}

  async add(bytes: number): Promise<void> {
    this.done += bytes;
    if (this.enabled && Date.now() - this.drawn > 250) await this.draw();
  }

  async finish(): Promise<void> {
    if (!this.enabled) return;
    await this.draw();
    await this.cmd.write('\n');
  }

  private async draw() {
    this.drawn = Date.now();
    const secs = Math.max((this.drawn - this.started) / 1000, 0.001);
    const pct = this.size > 0 ? Math.floor(this.done / this.size * 100) : 100;
    const rate = `${humanizeSize(this.done / secs)}/s`;
    const width = Math.max(this.cmd.cols - 32, 10);
    const name = this.name.length > width ? this.name.slice(0, width - 1) + '…' : this.name.padEnd(width);
    await this.cmd.write(`\r${name} ${String(pct).padStart(3)}% ${humanizeSize(this.done).padStart(9)} ${rate.padStart(11)}`);
  }
}

/** Counts bytes through to the progress meter */
function counting(progress: Progress): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream({
    async transform(chunk, controller) {
      controller.enqueue(chunk);
      await progress.add(chunk.length);
    },
  });
}

/**
 * Whether a node holds other nodes the way a directory does. EiN has several
 * such types — a home directory is the `user` node — and a file's own children
 * (metadata, thumbnails) do not make it one.
 */
function isContainer(node: { type: string }): boolean {
  return node.type !== NODE_TYPE_FILE && node.type !== NODE_TYPE_SOFTLINK;
}

/** Whether a path segment holds an unescaped `*`, `?` or `[` */
function hasGlob(segment: string): boolean {
  return /(^|[^\\])(\\\\)*[*?[]/.test(segment);
}

/** A literal segment with its backslash escapes taken out */
function unescapeGlob(segment: string): string {
  return segment.replace(/\\(.)/g, '$1');
}

class Scp {
  errors = 0;

  constructor(private cmd: Command, private sftp: SFTP, private args: ScpArgs) {}

  private async fail(message: string) {
    this.errors++;
    await this.cmd.writeError(`scp: ${message}\n`);
  }

  private progress(name: string, size: number) {
    return new Progress(this.cmd, name, size, this.cmd.tty && !this.args.quiet);
  }

  // ===== Remote → VFS =====

  /**
   * Remote paths named by an operand, as glob(3) expands them for OpenSSH's
   * scp: `*`, `?` and `[…]` in any segment, a backslash escaping one, and a
   * leading dot matched only by a pattern that starts with one. Sorted; empty
   * when nothing matches.
   */
  async expandRemote(path: string): Promise<string[]> {
    const segments = path.split('/');
    if (!segments.some(hasGlob)) return [path];

    // '' joined to a segment is that segment, relative to the remote home
    let bases = [path.startsWith('/') ? '/' : ''];
    for (const [i, segment] of segments.entries()) {
      if (segment === '') continue;
      const last = i === segments.length - 1;
      const next: string[] = [];
      for (const base of bases) {
        if (!hasGlob(segment)) {
          next.push(posix.join(base, unescapeGlob(segment)));
          continue;
        }
        const re = globToRegExp(segment, { extended: false, globstar: false });
        const entries = await this.sftp.readdir(base || '.').catch(() => []);
        for (const entry of entries) {
          const name = entry.filename;
          if (!re.test(name) || (name.startsWith('.') && !segment.startsWith('.'))) continue;
          // An inner segment only goes on through directories (links followed)
          if (!last) {
            const stats = sftpKind(entry.attrs) === 'directory' ? entry.attrs : await this.sftp.stat(posix.join(base, name)).catch(() => undefined);
            if (!stats || sftpKind(stats) !== 'directory') continue;
          }
          next.push(posix.join(base, name));
        }
      }
      bases = next;
    }
    return bases.sort();
  }

  async download(remote: string, local: string, multiple: boolean): Promise<void> {
    let stats;
    try {
      stats = await this.sftp.stat(remote);
    } catch (error) {
      return await this.fail(`${remote}: ${(error as Error).message}`);
    }

    const vfs = this.cmd.sys.vfs;
    const access = this.cmd.access;
    const localNode = await vfs.get(access, local).catch(() => undefined);
    const intoDir = localNode !== undefined && isContainer(localNode);
    if (multiple && !intoDir) return await this.fail(`${local}: Not a directory`);
    const target = intoDir ? posix.join(local, posix.basename(remote)) : local;

    const kind = sftpKind(stats);
    if (kind === 'directory') {
      if (!this.args.recursive) return await this.fail(`${remote}: not a regular file`);
      await this.downloadDir(remote, target);
    } else if (kind === 'file') {
      await this.downloadFile(remote, target, stats);
    } else {
      await this.fail(`${remote}: not a regular file`);
    }
  }

  private async downloadDir(remote: string, local: string): Promise<void> {
    const vfs = this.cmd.sys.vfs;
    const access = this.cmd.access;
    if (!await vfs.exists(access, local)) {
      await vfs.create(access, NODE_TYPE_DIRECTORY, posix.dirname(local), posix.basename(local));
    }

    let entries;
    try {
      entries = await this.sftp.readdir(remote);
    } catch (error) {
      return await this.fail(`${remote}: ${(error as Error).message}`);
    }

    for (const entry of entries.sort((a, b) => a.filename.localeCompare(b.filename))) {
      const from = posix.join(remote, entry.filename);
      const to = posix.join(local, entry.filename);
      // scp follows links on the remote side
      const stats = await this.sftp.stat(from).catch(() => undefined);
      if (!stats) {
        await this.fail(`${from}: cannot stat`);
      } else if (sftpKind(stats) === 'directory') {
        await this.downloadDir(from, to);
      } else if (sftpKind(stats) === 'file') {
        await this.downloadFile(from, to, stats);
      }
    }
  }

  private async downloadFile(remote: string, local: string, stats: FileAttributes): Promise<void> {
    const vfs = this.cmd.sys.vfs;
    const access = this.cmd.access;
    const name = posix.basename(local);
    const mode = stats.mode;
    const size = Number(stats.size ?? 0);

    let fh;
    try {
      fh = await vfs.open(access, local, { mode: 'w' });
    } catch (error) {
      if (!(error instanceof NodeNotFoundError)) return await this.fail(`${local}: ${(error as Error).message}`);
      try {
        await vfs.create<FileAttrs>(access, NODE_TYPE_FILE, posix.dirname(local), name, {
          props: this.args.preserve && mode !== undefined ? { mode: mode & 0o777 } : {},
          attrs: { name, mimetype: 'application/octet-stream', size: 0 },
        });
        fh = await vfs.open(access, local, { mode: 'w' });
      } catch (err) {
        return await this.fail(`${local}: ${(err as Error).message}`);
      }
    }

    const handle = await this.sftp.open(remote, 'r');
    const progress = this.progress(posix.basename(remote), size);
    const collector = createFileAttrsCollector();
    try {
      await sftpReadable(this.sftp, handle)
        .pipeThrough(counting(progress))
        .pipeThrough(collector.stream)
        .pipeTo(fh.writable);
    } catch (error) {
      await fh.close().catch(() => {});
      return await this.fail(`${remote}: ${(error as Error).message}`);
    } finally {
      await this.sftp.close(handle).catch(() => {});
    }
    await progress.finish();

    // As an upload does: recording what the bytes are is what starts the pipelines.
    // A file's modification time is its `writtenAt`, which the write just stamped
    const attrs: Partial<FileAttrs> = await collector.finalize();
    if (this.args.preserve && stats.mtime !== undefined) {
      attrs.writtenAt = (stats.mtime instanceof Date ? stats.mtime : new Date(stats.mtime * 1000)).toISOString();
    }
    await vfs.update<FileAttrs>(access, local, { attrs });
  }

  // ===== VFS → remote =====

  async upload(local: string, remoteDest: string, multiple: boolean): Promise<void> {
    const vfs = this.cmd.sys.vfs;
    const access = this.cmd.access;

    let node;
    try {
      node = await vfs.get<FileAttrs>(access, local);
    } catch (error) {
      return await this.fail(`${local}: ${(error as Error).message}`);
    }

    const destStats = await this.sftp.stat(remoteDest).catch(() => undefined);
    const intoDir = destStats !== undefined && sftpKind(destStats) === 'directory';
    if (multiple && !intoDir) return await this.fail(`${remoteDest}: Not a directory`);
    const target = intoDir ? posix.join(remoteDest, basename(local)) : remoteDest;

    if (node.type === NODE_TYPE_FILE) {
      await this.uploadFile(local, target, Number(node.attrs.size ?? 0), node.props.mode, contentTime(node));
    } else if (isContainer(node)) {
      if (!this.args.recursive) return await this.fail(`${local}: not a regular file`);
      await this.uploadDir(local, target);
    } else {
      await this.fail(`${local}: not a regular file`);
    }
  }

  private async uploadDir(local: string, remote: string): Promise<void> {
    const exists = await this.sftp.stat(remote).catch(() => undefined);
    if (!exists) {
      try {
        await this.sftp.mkdir(remote);
      } catch (error) {
        return await this.fail(`${remote}: ${(error as Error).message}`);
      }
    } else if (sftpKind(exists) !== 'directory') {
      return await this.fail(`${remote}: Not a directory`);
    }

    const entries = await this.cmd.sys.vfs.children<FileAttrs>(this.cmd.access, local);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const from = posix.join(local, entry.name);
      const to = posix.join(remote, entry.name);
      if (entry.node.type === NODE_TYPE_FILE) {
        await this.uploadFile(from, to, Number(entry.node.attrs.size ?? 0), entry.node.props.mode, contentTime(entry.node));
      } else if (entry.node.type === NODE_TYPE_DIRECTORY || (isContainer(entry.node) && entry.childCount > 0)) {
        await this.uploadDir(from, to);
      }
    }
  }

  private async uploadFile(local: string, remote: string, size: number, mode?: number, mtimeMs?: number): Promise<void> {
    let fh;
    try {
      fh = await this.cmd.sys.vfs.open(this.cmd.access, local, { mode: 'r' });
    } catch (error) {
      return await this.fail(`${local}: ${(error as Error).message}`);
    }

    let handle;
    try {
      handle = await this.sftp.open(remote, 'w', { mode: (mode ?? 0o644) & 0o777 });
    } catch (error) {
      await fh.close().catch(() => {});
      return await this.fail(`${remote}: ${(error as Error).message}`);
    }

    const progress = this.progress(basename(local), size);
    try {
      await fh.readable.pipeThrough(counting(progress)).pipeTo(sftpWritable(this.sftp, handle));
    } catch (error) {
      return await this.fail(`${remote}: ${(error as Error).message}`);
    } finally {
      await this.sftp.close(handle).catch(() => {});
      await fh.close().catch(() => {});
    }
    await progress.finish();

    if (this.args.preserve) {
      try {
        if (mode !== undefined) await this.sftp.chmod(remote, mode & 0o777);
        if (mtimeMs !== undefined) {
          const secs = Math.floor(mtimeMs / 1000);
          await this.sftp.utimes(remote, secs, secs);
        }
      } catch (error) {
        await this.fail(`${remote}: set times: ${(error as Error).message}`);
      }
    }
  }
}

export const scp = async (cmd: Command): CmdReturn => {
  let args: ScpArgs;
  try {
    args = parseScpArgs(cmd.args);
  } catch (error) {
    await cmd.writeError(`scp: ${(error as Error).message}\nusage: scp [-Bpqr] [-F configfile] [-i identity] [-o option] [-P port] source ... target\n`);
    return 1;
  }

  if (args.operands.length < 2) {
    await cmd.writeError('usage: scp [-Bpqr] [-F configfile] [-i identity] [-o option] [-P port] source ... target\n');
    return 1;
  }

  const destSpec = args.operands[args.operands.length - 1];
  const sourceSpecs = args.operands.slice(0, -1);
  const dest = parseScpOperand(destSpec);
  const sources = sourceSpecs.map((s) => parseScpOperand(s));

  let remote: ScpOperand;
  if (dest) {
    if (sources.some((s) => s)) {
      await cmd.writeError('scp: copying between two remote hosts is not supported; copy into EiN first\n');
      return 1;
    }
    remote = dest;
  } else {
    if (sources.some((s) => !s)) {
      await cmd.writeError('scp: nothing remote to copy; use cp within EiN\n');
      return 1;
    }
    const first = sources[0]!;
    if (sources.some((s) => s!.host !== first.host || s!.user !== first.user)) {
      await cmd.writeError('scp: all remote sources must be on the same host\n');
      return 1;
    }
    remote = first;
  }

  if (!await checkSshAllowed(cmd, 'scp')) return 1;

  let config: SshConfigOptions;
  try {
    config = await hostSettings(cmd, remote.host, { ...args.config, user: remote.user ?? args.config.user }, args.configFile);
  } catch (error) {
    await cmd.writeError(`scp: ${(error as Error).message}\n`);
    return 1;
  }

  const abort = new AbortController();
  cmd.onInterrupt(() => abort.abort());

  let client: Client | undefined;
  try {
    client = await connectSsh(sshUserFromCommand(cmd), connectOptions(remote.host, config, abort.signal));
    const sftp = await client.sftp();
    abort.signal.addEventListener('abort', () => client?.end(), { once: true });

    const job = new Scp(cmd, sftp, args);
    if (dest) {
      const remoteDest = dest.path || '.';
      for (const spec of sourceSpecs) {
        await job.upload(resolve(cmd.cwd, spec), remoteDest, sourceSpecs.length > 1);
      }
    } else {
      const local = resolve(cmd.cwd, destSpec);
      const paths: string[] = [];
      for (const source of sources) paths.push(...await job.expandRemote(source!.path || '.'));
      if (!paths.length) {
        await cmd.writeError(`scp: ${sourceSpecs.join(' ')}: No match\n`);
        return 1;
      }
      for (const path of paths) await job.download(path, local, paths.length > 1);
    }

    return job.errors ? 1 : 0;
  } catch (error) {
    if (abort.signal.aborted) return 130;
    const message = error instanceof SshConnectError ? error.message : (error as Error).message;
    await cmd.writeError(`scp: ${message}\n`);
    return 1;
  } finally {
    cmd.onInterrupt(null);
    client?.end();
  }
};

scp.spec = {
  name: 'scp',
  effect: 'write' as const,
  json: false,
  description: 'Copy files between EiN and another machine over SSH (members of group ssh)',
  args: [
    { name: 'source', type: 'path' as const, variadic: true, description: 'files to copy: EiN paths, or [user@]host:path' },
    { name: 'target', type: 'path' as const, description: 'where to: an EiN path, or [user@]host:path' },
  ],
  flags: [
    { name: 'r', type: 'bool' as const, description: 'copy directories recursively' },
    { name: 'p', type: 'bool' as const, description: 'keep modes and modification times' },
    { name: 'q', type: 'bool' as const, description: 'no progress meter' },
    { name: 'B', type: 'bool' as const, description: 'batch mode: never ask for passwords or passphrases' },
    { name: 'P', type: 'number' as const, description: 'port (default 22)' },
    { name: 'i', type: 'path' as const, description: 'identity file' },
    { name: 'F', type: 'path' as const, description: 'config file (default ~/.ssh/config; none: no file)' },
    { name: 'o', type: 'string' as const, repeatable: true, description: 'ssh option, e.g. StrictHostKeyChecking=accept-new' },
  ],
  examples: [
    'scp anna@nas.local:photos/sailboat.jpg "/archive/albums/Summer 2020/"',
    'scp "anna@nas.local:photos/*.jpg" "/archive/albums/Summer 2020/"',
    'scp -r "/archive/albums/Summer 2020" anna@nas.local:backup/',
  ],
  returns: 'nothing; 1 when any file failed.',
};
