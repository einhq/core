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
 * A path that would leave `dest` is refused.
 */
export const unpackArchive = async (vfs: NodeVFS, access: Access, archive: ReadableStream<Uint8Array>, dest: string): Promise<Unpacked> => {
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
    } else {
      await entry.readable?.cancel();
      skipped.push(`${relative}: ${type === '2' ? 'a symlink' : `an entry of type '${type}'`}, not installed`);
    }
  }
  return { files, skipped };
};
