import { basename } from '@std/path';
import { Access } from '../../../lib/access/mod.ts';
import { createFileAttrsCollector } from '../../../lib/media/file-attrs.ts';
import { FileAttrs } from '../../../vfs/types/file.ts';
import { HttpServerConfig } from '../types.ts';

/**
 * Stream an uploaded body into the existing file node at `vfsPath`, replacing its bytes, and
 * record the size, sha256 and mimetype read on the way through.
 * @returns the node's attrs after the write
 */
export async function storeBody(
  config: HttpServerConfig,
  access: Access,
  vfsPath: string,
  body: ReadableStream<Uint8Array> | null,
): Promise<FileAttrs> {
  const fh = await config.vfs.open(access, vfsPath, { mode: 'w' });
  const collector = createFileAttrsCollector(basename(vfsPath));

  try {
    if (body) await body.pipeThrough(collector.stream).pipeTo(fh.writable);
  } finally {
    await fh.close();
  }

  const node = await config.vfs.update<FileAttrs>(access, vfsPath, {
    attrs: await collector.finalize(),
  });
  return node.attrs;
}
