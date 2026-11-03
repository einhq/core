/**
 * A module's tree in the VFS from a repository's archive, and the record of where it came from.
 *
 * `mod install` unpacks into a staging directory beside the installed modules and renames it into
 * place, so a module directory is always one whole tree. Each installed module carries
 * `.install.json`, its `ModuleInstall`: the repository, the ref and the commit.
 */

import { basename, dirname, join } from '@std/path';
import { toText } from '@std/streams/to-text';
import { UntarStream } from '@std/tar/untar-stream';
import type { ModuleInstall } from '../lib/api/mod.ts';
import type { Access } from '../lib/access/mod.ts';
import { getMimeFromExt } from '../lib/media/mod.ts';
import type { NodeVFS } from '../vfs/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../vfs/types/directory.ts';
import { type FileAttrs, NODE_TYPE_FILE } from '../vfs/types/file.ts';
import { MOD_JSON_NAME } from './types.ts';

/** The record of an install, in the module's directory. */
const INSTALL_RECORD = '.install.json';

/** How `mod install` names a tree it is still unpacking, beside the installed modules: hidden from `ls`. */
export const STAGING_PREFIX = '.staging-';

/** Where `mod install` keeps the tree it replaces until the new one is in place. */
export const REPLACED_PREFIX = '.replaced-';

/** The install record of the module at `modulePath`; nothing for a module `mod install` did not put there. */
export const readInstallRecord = async (vfs: NodeVFS, access: Access, modulePath: string): Promise<ModuleInstall | undefined> => {
  try {
    const handle = await vfs.open(access, join(modulePath, INSTALL_RECORD), { mode: 'r' });
    try {
      const record = JSON.parse(await toText(handle.readable)) as Partial<ModuleInstall>;
      if (typeof record.repository !== 'string' || typeof record.commit !== 'string') return undefined;
      return { repository: record.repository, ref: record.ref ?? record.commit, commit: record.commit, at: record.at ?? '' };
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
};

/** Write a whole file, created with `mode`. */
const writeFile = async (vfs: NodeVFS, access: Access, path: string, bytes: Uint8Array, mode: number): Promise<void> => {
  const name = basename(path);
  const attrs: FileAttrs = { name, mimetype: await getMimeFromExt(name), size: bytes.length };
  await vfs.create<FileAttrs>(access, NODE_TYPE_FILE, dirname(path), name, { props: { uid: access.uid, gid: access.gid, mode }, attrs });
  const handle = await vfs.open(access, path, { mode: 'w' });
  try {
    await handle.write(bytes);
  } finally {
    await handle.close();
  }
};

export const writeInstallRecord = async (vfs: NodeVFS, access: Access, modulePath: string, record: ModuleInstall): Promise<void> =>
  await writeFile(vfs, access, join(modulePath, INSTALL_RECORD), new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`), 0o644);

/** A module's pages, which only the browser runs: `mod.json`'s `ui` and every file under `ui/`. */
const PAGES = 'ui';

/** The files under `root`, by their path relative to it, leaving out the pages and the install record. */
const filesBeyondPages = async (vfs: NodeVFS, access: Access, root: string, relative = ''): Promise<Map<string, number>> => {
  const files = new Map<string, number>();
  for (const child of await vfs.children<FileAttrs>(access, join(root, relative))) {
    const path = relative ? `${relative}/${child.name}` : child.name;
    if (path === PAGES || path === INSTALL_RECORD) continue;
    if (child.node.type === NODE_TYPE_DIRECTORY) {
      for (const [inner, size] of await filesBeyondPages(vfs, access, root, path)) files.set(inner, size);
    } else {
      files.set(path, child.node.attrs.size ?? -1);
    }
  }
  return files;
};

const readBytes = async (vfs: NodeVFS, access: Access, path: string): Promise<Uint8Array> => {
  const handle = await vfs.open(access, path, { mode: 'r' });
  try {
    return new Uint8Array(await new Response(handle.readable).arrayBuffer());
  } finally {
    await handle.close();
  }
};

/** `mod.json` as its services read it: without the version a release raises, or the pages. */
const manifestBeyondPages = (bytes: Uint8Array): string => {
  try {
    const { version: _version, [PAGES]: _pages, ...rest } = JSON.parse(new TextDecoder().decode(bytes));
    return JSON.stringify(rest);
  } catch {
    return new TextDecoder().decode(bytes);
  }
};

/**
 * Whether the module tree at `after` differs from the one at `before` in anything but its pages:
 * a file added, removed or changed outside `ui/`, or `mod.json` beyond its `version` and `ui`. The
 * module's services run none of its pages, so an update that changed only those leaves them
 * running (ein/core#862).
 */
export const changedBeyondPages = async (vfs: NodeVFS, access: Access, before: string, after: string): Promise<boolean> => {
  const old = await filesBeyondPages(vfs, access, before);
  const now = await filesBeyondPages(vfs, access, after);
  if (old.size !== now.size) return true;
  // Smallest first: a release's commands and libs are small, and a change there ends the reading.
  for (const [path, size] of [...now].sort(([, a], [, b]) => a - b)) {
    if (!old.has(path)) return true;
    const manifest = path === MOD_JSON_NAME;
    if (!manifest && old.get(path) !== size) return true;
    const [a, b] = await Promise.all([readBytes(vfs, access, join(before, path)), readBytes(vfs, access, join(after, path))]);
    if (manifest ? manifestBeyondPages(a) !== manifestBeyondPages(b) : a.length !== b.length || !a.every((byte, i) => byte === b[i])) return true;
  }
  return false;
};

/** The `path` record of a pax extended header, which names the entry after it when its name is too long for the tar header. */
const paxPath = (bytes: Uint8Array): string | undefined => {
  const text = new TextDecoder().decode(bytes);
  for (const line of text.split('\n')) {
    const match = /^\d+ path=(.*)$/.exec(line);
    if (match) return match[1];
  }
  return undefined;
};

/** What `unpackArchive` wrote, and the entries it left out with why. */
type Unpacked = { files: number; skipped: string[] };

/**
 * Unpack a gzipped tar of a repository into `dest`, which must exist: the entries under its one top
 * directory, which a forge names after the repository. Directories and files are written with
 * their modes, so a command stays executable; symlinks and anything else are left out, and said.
 * A path that would leave `dest` is refused. `unpacked` is told the number of files in place after each.
 */
export const unpackArchive = async (
  vfs: NodeVFS,
  access: Access,
  archive: ReadableStream<Uint8Array>,
  dest: string,
  unpacked?: (files: number) => Promise<void>,
): Promise<Unpacked> => {
  const parentOf = (relative: string): string => dirname(relative) === '.' ? '' : dirname(relative);
  const made = new Set<string>(['']);
  const ensureDir = async (relative: string): Promise<void> => {
    if (made.has(relative)) return;
    await ensureDir(parentOf(relative));
    await vfs.ensure(access, NODE_TYPE_DIRECTORY, join(dest, parentOf(relative)), basename(relative), { props: { mode: 0o755 } });
    made.add(relative);
  };

  let files = 0;
  const skipped: string[] = [];
  let nextPath: string | undefined;
  // The runtime types the stream's writable side as BufferSource, which a stream of bytes is.
  const gunzip = new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>;
  for await (const entry of archive.pipeThrough(gunzip).pipeThrough(new UntarStream())) {
    const type = entry.header.typeflag;
    if (type === 'g' || type === 'x') {
      const bytes = entry.readable ? new Uint8Array(await new Response(entry.readable).arrayBuffer()) : new Uint8Array();
      if (type === 'x') nextPath = paxPath(bytes);
      continue;
    }
    const path = nextPath ?? entry.path;
    nextPath = undefined;

    // Everything sits under the archive's one top directory.
    const relative = path.split('/').filter((part) => part && part !== '.').slice(1).join('/');
    if (!relative) {
      await entry.readable?.cancel();
      continue;
    }
    if (relative.split('/').includes('..') || path.startsWith('/')) {
      await entry.readable?.cancel();
      throw new Error(`the archive names a path outside the module: ${path}`);
    }

    if (type === '5') {
      await ensureDir(relative);
    } else if (type === '0' || type === '7') {
      await ensureDir(parentOf(relative));
      const bytes = entry.readable ? new Uint8Array(await new Response(entry.readable).arrayBuffer()) : new Uint8Array();
      await writeFile(vfs, access, join(dest, relative), bytes, entry.header.mode & 0o777 || 0o644);
      files++;
      await unpacked?.(files);
    } else {
      await entry.readable?.cancel();
      skipped.push(`${relative}: ${type === '2' ? 'a symlink' : `an entry of type '${type}'`}, not installed`);
    }
  }
  return { files, skipped };
};
