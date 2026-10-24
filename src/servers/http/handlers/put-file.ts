import { basename, dirname } from '@std/path';
import { NodeAlreadyExistsError } from '../../../vfs/mod.ts';
import { NODE_TYPE_FILE } from '../../../vfs/types/file.ts';
import { getSession } from '../session.ts';
import { HttpServerConfig } from '../types.ts';
import { storeBody } from './store-body.ts';

/**
 * PUT /file/<path> — store the body at exactly this path, creating the file or replacing the
 * bytes of the one already there. Uploads that must not replace anything use POST
 * (`post-file.ts`).
 */
export async function handlePutFile(config: HttpServerConfig, req: Request, url: URL): Promise<Response> {
  const { responseHeaders, access } = await getSession(config, req.headers, { create: false });
  const vfsPath = decodeURIComponent(url.pathname.replace('/file', ''));
  const fileName = basename(vfsPath);

  if (!(await config.vfs.exists(access, vfsPath))) {
    try {
      await config.vfs.create(access, NODE_TYPE_FILE, dirname(vfsPath), fileName, { attrs: { name: fileName } });
    } catch (e) {
      // Another PUT of the same new path created it first; this one replaces its bytes.
      if (!(e instanceof NodeAlreadyExistsError)) throw e;
    }
  }

  const attrs = await storeBody(config, access, vfsPath, req.body);

  return new Response(JSON.stringify({ ok: true, ...attrs }), {
    status: 201,
    headers: { ...responseHeaders, 'Content-Type': 'application/json' },
  });
}
