/**
 * The type of an uploaded file that a client moved onto its final name. Clients that write to a
 * temporary name and rename it when done (`photo.cr2.filepart`, `photo.jpg.tacitpart`) get the
 * type an upload under the final name gets.
 */

import { basename } from '@std/path';
import type { Access } from '../access/mod.ts';
import type { Node } from '../../vfs/node.ts';
import type { NodeVFS } from '../../vfs/node-vfs.ts';
import { NODE_TYPE_FILE } from '../../vfs/types/file.ts';
import { freezesUpload } from './frozen-uploads.ts';
import { refineMimeByName } from './raw.ts';

/**
 * Apply the name rules (`refineMimeByName`) to `node`, a file now at `path`, and freeze it when
 * `/etc/frozen-uploads` lists the type that gives. A file without a mimetype, not read yet, is left
 * as it is.
 */
export async function retypeMovedUpload(vfs: NodeVFS, access: Access, path: string, node: Node): Promise<void> {
  const mimetype = (node.attrs as { mimetype?: unknown }).mimetype;
  if (node.type !== NODE_TYPE_FILE || typeof mimetype !== 'string') return;
  const named = refineMimeByName(mimetype, basename(path));
  if (named === mimetype) return;
  const frozen = !node.attrs.frozen && await freezesUpload(vfs, named);
  await vfs.update(access, path, { attrs: { mimetype: named, ...(frozen ? { frozen } : {}) } });
}
