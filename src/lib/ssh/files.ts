/**
 * Reading and writing the small private files under `~/.ssh` in the VFS.
 */

import { toText } from '@std/streams';
import { basename, dirname } from '@std/path';
import type { Access } from '../access/types.ts';
import type { NodeVFS } from '../../vfs/node-vfs.ts';
import { NODE_TYPE_DIRECTORY } from '../../vfs/types/directory.ts';
import { type FileAttrs, NODE_TYPE_FILE } from '../../vfs/types/file.ts';

/** The directory OpenSSH keeps its per-user files in */
export function sshDir(home: string): string {
  return `${home.replace(/\/+$/, '')}/.ssh`;
}

/** A file's text, or undefined when it does not exist */
export async function readText(vfs: NodeVFS, access: Access, path: string): Promise<string | undefined> {
  if (!await vfs.exists(access, path)) return undefined;
  const handle = await vfs.open(access, path, { mode: 'r' });
  try {
    return await toText(handle.readable);
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Create `~/.ssh` (mode 0700) when it is missing */
export async function ensureSshDir(vfs: NodeVFS, access: Access, home: string): Promise<string> {
  const dir = sshDir(home);
  if (!await vfs.exists(access, dir)) {
    await vfs.create(access, NODE_TYPE_DIRECTORY, home, '.ssh', {
      props: { uid: access.uid, gid: access.gid, mode: 0o700 },
    });
  }
  return dir;
}

/**
 * Write a whole file, creating it the first time with `mode`. Keys and
 * known_hosts are content the user made, not a regenerable rendition, so they
 * live on the `db` tier (backed up with the database).
 */
export async function writeText(
  vfs: NodeVFS,
  access: Access,
  path: string,
  text: string,
  mode: number,
): Promise<void> {
  const encoded = new TextEncoder().encode(text);

  if (!await vfs.exists(access, path)) {
    const name = basename(path);
    const attrs: FileAttrs = { name, mimetype: 'text/plain', size: encoded.length };
    await vfs.create<FileAttrs>(access, NODE_TYPE_FILE, dirname(path), name, {
      props: { uid: access.uid, gid: access.gid, mode, tier: 'db' },
      attrs,
    });
  }

  const handle = await vfs.open(access, path, { mode: 'w' });
  try {
    await handle.write(encoded);
  } finally {
    await handle.close();
  }
}

/** Append a line, creating the file (mode 0600) when it is missing */
export async function appendLine(vfs: NodeVFS, access: Access, path: string, line: string): Promise<void> {
  const current = await readText(vfs, access, path) ?? '';
  const sep = current === '' || current.endsWith('\n') ? '' : '\n';
  await writeText(vfs, access, path, `${current}${sep}${line}\n`, 0o600);
}
