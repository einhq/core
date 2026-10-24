import { join } from '@std/path';
import { Access } from '../../../lib/access/mod.ts';
import { NodeAlreadyExistsError } from '../../../vfs/mod.ts';
import { NODE_TYPE_FILE } from '../../../vfs/types/file.ts';
import { numberedName } from '../numbered-name.ts';
import { getSession } from '../session.ts';
import { HttpServerConfig } from '../types.ts';
import { storeBody } from './store-body.ts';

/** How many numbered names an upload tries before giving up on a directory. */
const MAX_NUMBERED = 10_000;

/**
 * POST /file/<directory>/?name=<name> — store an upload under a name nothing in the directory
 * has yet: `name`, or else the first free `name (2)`, `name (3)`, …
 *
 * Cameras number their files alike, so two phones uploading `IMG_0001.jpg` into one directory
 * is ordinary; neither may replace the other. The node is created before any byte is read, and
 * the store's unique-name rule decides which upload gets which name, so two at once both land.
 * A body that fails part-way removes the node it created.
 *
 * Answers 201 with the file's attrs, the `path` it was stored at, and `renamed` when that is
 * not the name asked for.
 */
export async function handlePostFile(config: HttpServerConfig, req: Request, url: URL): Promise<Response> {
  const { responseHeaders, access } = await getSession(config, req.headers, { create: false });
  const dirPath = decodeURIComponent(url.pathname.replace('/file', '')).replace(/\/+$/, '') || '/';
  const name = url.searchParams.get('name') ?? '';

  if (name === '' || name === '.' || name === '..' || name.includes('/')) {
    return new Response('a ?name= without a slash is required', { status: 400, headers: responseHeaders });
  }

  const storedName = await createFreeName(config, access, dirPath, name);
  if (storedName === undefined) {
    return new Response(`no free name for ${name} in ${dirPath}`, { status: 409, headers: responseHeaders });
  }

  const vfsPath = join(dirPath, storedName);
  const attrs = await storeBody(config, access, vfsPath, req.body).catch(async (e) => {
    await config.vfs.unlink(access, vfsPath, dirPath).catch(() => {});
    throw e;
  });

  return new Response(JSON.stringify({ ok: true, path: vfsPath, renamed: storedName !== name, ...attrs }), {
    status: 201,
    headers: {
      ...responseHeaders,
      'Content-Type': 'application/json',
      Location: `/file${vfsPath.split('/').map(encodeURIComponent).join('/')}`,
    },
  });
}

/** Create an empty file node under `name` or its first free numbered name, and return that name. */
async function createFreeName(config: HttpServerConfig, access: Access, dirPath: string, name: string): Promise<string | undefined> {
  for (let n = 1; n <= MAX_NUMBERED; n++) {
    const candidate = n === 1 ? name : numberedName(name, n);
    try {
      await config.vfs.create(access, NODE_TYPE_FILE, dirPath, candidate, { attrs: { name: candidate } });
      return candidate;
    } catch (e) {
      if (!(e instanceof NodeAlreadyExistsError)) throw e;
    }
  }
  return undefined;
}
