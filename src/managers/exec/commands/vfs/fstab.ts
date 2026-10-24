/**
 * `/etc/fstab`: mounts made again at every boot (`mount -a`), one per line:
 *
 *   <mount point> <type> <options>
 *
 * Fields are separated by whitespace; one holding a space is double-quoted.
 * `#` starts a comment line. `mount --save` and `unmount --save` keep it.
 */

import { basename, dirname } from '@std/path';
import type { Access } from '../../../../lib/access/types.ts';
import type { NodeVFS } from '../../../../vfs/node-vfs.ts';
import { type FileAttrs, NODE_TYPE_FILE } from '../../../../vfs/types/file.ts';
import { toText } from '@std/streams';

export interface FstabEntry {
  point: string;
  type: string;
  options: string;
}

function splitFields(line: string): string[] {
  const fields: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (const m of line.matchAll(re)) fields.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]);
  return fields;
}

function quote(field: string): string {
  return /[\s"#]/.test(field) || field === '' ? `"${field.replace(/["\\]/g, '\\$&')}"` : field;
}

export function parseFstab(text: string): FstabEntry[] {
  const entries: FstabEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [point, type, options = ''] = splitFields(trimmed);
    if (point && type) entries.push({ point, type, options });
  }
  return entries;
}

function formatFstabLine(entry: FstabEntry): string {
  return [entry.point, entry.type, entry.options].filter((f, i) => i < 2 || f !== '').map(quote).join(' ');
}

export async function readFstab(vfs: NodeVFS, access: Access, path: string): Promise<string> {
  if (!await vfs.exists(access, path)) return '';
  const handle = await vfs.open(access, path, { mode: 'r' });
  try {
    return await toText(handle.readable);
  } finally {
    await handle.close();
  }
}

/**
 * Replace the line for `point` (or drop it, with no `entry`), keeping every
 * other line — comments included — as it was.
 */
export async function updateFstab(
  vfs: NodeVFS,
  access: Access,
  path: string,
  point: string,
  entry: FstabEntry | undefined,
): Promise<boolean> {
  const text = await readFstab(vfs, access, path);
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  let changed = false;

  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return true;
    const same = splitFields(trimmed)[0] === point;
    changed ||= same;
    return !same;
  });
  if (entry) {
    kept.push(formatFstabLine(entry));
    changed = true;
  }
  if (!changed) return false;

  const encoded = new TextEncoder().encode(kept.length ? `${kept.join('\n')}\n` : '');
  if (!await vfs.exists(access, path)) {
    const name = basename(path);
    await vfs.create<FileAttrs>(access, NODE_TYPE_FILE, dirname(path), name, {
      // Hosts and users of other machines: not for everyone to read
      props: { uid: access.uid, gid: access.gid, mode: 0o600, tier: 'db' },
      attrs: { name, mimetype: 'text/plain', size: encoded.length },
    });
  }
  const handle = await vfs.open(access, path, { mode: 'w' });
  try {
    await handle.write(encoded);
  } finally {
    await handle.close();
  }
  return true;
}
