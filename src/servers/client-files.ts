/** What clients of the file servers, SFTP and WebDAV, see as a file rather than a folder. */

import type { Node } from '../vfs/mod.ts';
import { NODE_TYPE_EMBEDDING } from '../vfs/types/embedding.ts';
import { NODE_TYPE_FILE } from '../vfs/types/file.ts';
import { NODE_TYPE_LOG } from '../vfs/types/log.ts';
import { NODE_TYPE_STREAM } from '../vfs/types/stream.ts';

/** The node types a client sees as files; a stream is read from now on and written by its one writer. */
const CLIENT_FILE_TYPES = new Set([
  NODE_TYPE_FILE,
  NODE_TYPE_EMBEDDING,
  NODE_TYPE_LOG,
  NODE_TYPE_STREAM,
]);

/** Whether a client sees `node` as a file; every other node is a folder to it. */
export const isClientFile = (node: Pick<Node, 'type'>): boolean => CLIENT_FILE_TYPES.has(node.type);
