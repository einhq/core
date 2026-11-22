/**
 * WebDAV at `/dav/`: the tree, `/dav/<path>` for `/<path>`, as whoever signs in with HTTP Basic,
 * with the same rights as over SFTP. For programs that sync files over HTTPS, such as a phone's
 * backup app, which cannot use SFTP where port 2222 is not open.
 *
 * Class 1: OPTIONS, PROPFIND (depth 0 the resource, any other one level), PROPPATCH, GET, HEAD,
 * PUT, MKCOL, MOVE and DELETE; no locks and no COPY. The session cookie means nothing here, and a
 * request a browser marks as coming from a page of another origin is refused whatever it carries.
 */

import { BodyTooLargeError, readBody, tooLarge } from '../body-limit.ts';
import { clientAddress } from '../client-address.ts';
import type { DownloadLog } from '../download-log.ts';
import { serveFile } from '../handlers/get-file.ts';
import { isCrossOrigin } from '../same-origin.ts';
import type { HttpServerConfig } from '../types.ts';
import { TrashError } from '../../../lib/trash/mod.ts';
import {
  NodeAccessDeniedError,
  NodeAlreadyExistsError,
  NodeBusyError,
  NodeFrozenError,
  NodeInvalidOperationError,
  NodeNotFoundError,
  NodeReadonlyError,
  NodeTierImmutableError,
  NodeVersionConflictError,
} from '../../../vfs/mod.ts';
import { isClientFile } from '../../client-files.ts';
import { davPath } from './paths.ts';
import { firstPage, propfindBody, propRequest } from './propfind.ts';
import type { DavSignIns } from './sign-in.ts';
import { mkcol, move, proppatch, put, refuse, remove } from './write.ts';
import { parseXml, type XmlElement, XmlError } from './xml.ts';

/** The methods served, as `Allow` lists them. */
const ALLOW = 'OPTIONS, PROPFIND, PROPPATCH, GET, HEAD, PUT, MKCOL, MOVE, DELETE';

/** The largest PROPFIND or PROPPATCH body read; a client's are a few hundred bytes. */
const MAX_XML_BYTES = 256 * 1024;

/** What the WebDAV handler is given: the server's settings, its sign-ins and its download log. */
type DavContext = HttpServerConfig & { signIns: DavSignIns; downloads: DownloadLog };

/** A request body as an XML document; none when it is empty. */
async function xmlBody(req: Request): Promise<XmlElement | undefined> {
  const bytes = await readBody(req, MAX_XML_BYTES);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new XmlError('a body that is not UTF-8');
  }
  return text.trim() === '' ? undefined : parseXml(text);
}

/** The status a failed write or read is answered with, from what the tree threw. */
function failure(req: Request, error: unknown): Promise<Response> | undefined {
  const reason = error instanceof TrashError && error.cause !== undefined ? error.cause : error;
  const message = reason instanceof Error ? reason.message : String(reason);
  if (reason instanceof BodyTooLargeError) return Promise.resolve(tooLarge(reason));
  if (reason instanceof XmlError) return refuse(req, 400, `not a request this server takes: ${message}`);
  if (reason instanceof NodeNotFoundError) return refuse(req, 404, 'not found');
  if (reason instanceof NodeAccessDeniedError) return refuse(req, 403, 'forbidden');
  if (reason instanceof NodeFrozenError || reason instanceof NodeReadonlyError || reason instanceof NodeTierImmutableError) return refuse(req, 403, message);
  if (reason instanceof NodeAlreadyExistsError) return refuse(req, req.method === 'MKCOL' ? 405 : req.method === 'MOVE' ? 412 : 409, message);
  if (reason instanceof NodeInvalidOperationError || reason instanceof NodeBusyError || reason instanceof NodeVersionConflictError) return refuse(req, 409, message);
  if (reason instanceof TrashError) return refuse(req, 409, message);
  return undefined;
}

/** Answer a request under `/dav`. */
export async function handleDav(ctx: DavContext, req: Request, url: URL, remoteAddr: Deno.Addr): Promise<Response> {
  if (isCrossOrigin(req.headers)) return await refuse(req, 403, 'a page of another origin may not use WebDAV');
  if (req.method === 'OPTIONS') {
    await req.body?.cancel().catch(() => {});
    return new Response(null, { status: 200, headers: { DAV: '1', Allow: ALLOW, 'MS-Author-Via': 'DAV' } });
  }

  const path = davPath(url.pathname);
  if (path === undefined) return await refuse(req, 400, 'not a path in the tree');
  const from = clientAddress(req.headers, remoteAddr);
  const user = await ctx.signIns.signIn(req.headers, from);
  if (user instanceof Response) {
    await req.body?.cancel().catch(() => {});
    return user;
  }
  const write = { config: ctx, user };

  try {
    switch (req.method) {
      case 'GET':
      case 'HEAD': {
        const node = await ctx.vfs.get(user.access, path);
        if (!isClientFile(node)) {
          const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };
          return new Response(req.method === 'HEAD' ? null : 'a folder: a WebDAV client lists it with PROPFIND\n', { headers });
        }
        return await serveFile(ctx, req, path, user.access, new Headers(), { downloads: ctx.downloads, from, via: 'dav', original: true });
      }
      case 'PROPFIND': {
        const depth = req.headers.get('depth')?.trim().toLowerCase() ?? 'infinity';
        if (depth !== '0' && depth !== '1' && depth !== 'infinity') return await refuse(req, 400, 'Depth is 0, 1 or infinity');
        const request = propRequest(await xmlBody(req));
        const node = await ctx.vfs.get(user.access, path);
        // Any depth but 0 is one level: a whole subtree in one answer is never sent.
        const first = depth !== '0' && !isClientFile(node) ? await firstPage(ctx.vfs, user.access, path) : undefined;
        return new Response(propfindBody(ctx.vfs, user.access, path, node, request, first), {
          status: 207,
          headers: { 'Content-Type': 'application/xml; charset=utf-8' },
        });
      }
      case 'PROPPATCH': {
        const body = await xmlBody(req);
        if (!body) return await refuse(req, 400, 'a PROPPATCH needs a propertyupdate');
        return await proppatch(write, path, body);
      }
      case 'PUT':
        return await put(write, req, path);
      case 'MKCOL':
        return await mkcol(write, req, path);
      case 'MOVE':
        return await move(write, req, url, path);
      case 'DELETE':
        return await remove(write, req, path);
      default:
        return await refuse(req, 405, `${req.method} is not served here`, { Allow: ALLOW });
    }
  } catch (error) {
    const answer = failure(req, error);
    if (answer) return await answer;
    throw error;
  }
}
