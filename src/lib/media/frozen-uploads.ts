/**
 * Which uploads are frozen as they arrive: the types `/etc/frozen-uploads` lists. The HTTP upload
 * and SFTP mark a file they finished writing `frozen` when its mimetype is one of them, and so does
 * `unzip --as-upload` for each file it takes out of an uploaded archive; nothing else EiN writes is
 * frozen by it.
 *
 * The file holds one mimetype per line: `image/jpeg`, `image/*` for every subtype, or `!image/svg+xml`
 * to leave a type out that another line takes in. `#` starts a comment. A file that is missing or
 * lists nothing freezes nothing.
 */

import { toText } from '@std/streams';
import { join } from '@std/path';
import { ADMIN_ACCESS } from '../access/mod.ts';
import { ETC_PATH } from '../paths.ts';
import type { NodeVFS } from '../../vfs/node-vfs.ts';

const FROZEN_UPLOADS_PATH = join(ETC_PATH, 'frozen-uploads');

/** The lines of a frozen-uploads file, split into the types taken in and those left out. */
export type FrozenUploads = { include: string[]; exclude: string[] };

export function parseFrozenUploads(text: string): FrozenUploads {
  const policy: FrozenUploads = { include: [], exclude: [] };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim().toLowerCase();
    if (line === '') continue;
    if (line.startsWith('!')) {
      const type = line.slice(1).trim();
      if (type) policy.exclude.push(type);
    } else {
      policy.include.push(line);
    }
  }
  return policy;
}

const matches = (pattern: string, mimetype: string): boolean => pattern.endsWith('/*') ? mimetype.startsWith(pattern.slice(0, -1)) : pattern === mimetype;

/** Whether an upload of `mimetype` is frozen: a line takes it in and no `!` line leaves it out. */
export function freezes(policy: FrozenUploads, mimetype: string | undefined): boolean {
  const type = mimetype?.split(';')[0].trim().toLowerCase();
  if (!type) return false;
  return policy.include.some((p) => matches(p, type)) && !policy.exclude.some((p) => matches(p, type));
}

/** `/etc/frozen-uploads` as it is now; a missing file lists nothing. */
export async function readFrozenUploads(vfs: NodeVFS): Promise<FrozenUploads> {
  if (!await vfs.exists(ADMIN_ACCESS, FROZEN_UPLOADS_PATH)) return parseFrozenUploads('');
  const handle = await vfs.open(ADMIN_ACCESS, FROZEN_UPLOADS_PATH, { mode: 'r' });
  try {
    return parseFrozenUploads(await toText(handle.readable));
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Whether an upload of `mimetype` is frozen, by `/etc/frozen-uploads` as it is now. */
export async function freezesUpload(vfs: NodeVFS, mimetype: string | undefined): Promise<boolean> {
  return !!mimetype && freezes(await readFrozenUploads(vfs), mimetype);
}
