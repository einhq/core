import { parseByteRange } from '../../../lib/utils/mod.ts';
import { ResourceSeekMode } from '../../../registries/types.ts';
import { FileAttrs } from '../../../vfs/types/file.ts';
import { getSession, refusesGuest } from '../session.ts';
import { HttpServerConfig } from '../types.ts';
import { fileBody } from './file-body.ts';

type GetFileOptions = {
  /**
   * Mint a guest session (and set its cookie) when the request has none.
   *
   * Off for `/file/<path>`: an asset fetch only needs to know who is asking,
   * and a client that keeps no cookies would get a permanent session node per
   * request. `get-default` turns it on for a navigation to the SPA document,
   * which is the one response a browser will actually hold the cookie from.
   */
  createSession?: boolean;
  /**
   * The site's own pages, which `get-default` serves: the sign-in page among them, so the guest
   * reads them whether or not visitors may browse.
   */
  site?: boolean;
};

export async function handleGetFile(config: HttpServerConfig, req: Request, url: URL, opts: GetFileOptions = {}): Promise<Response> {
  const { responseHeaders, access } = await getSession(config, req.headers, { create: opts.createSession === true });
  if (!opts.site && await refusesGuest(config, access)) return new Response('sign in first', { status: 401, headers: responseHeaders });
  const vfsPath = decodeURIComponent(url.pathname.replace('/file', ''));
  // Resolved once for both the `get` and the `open` below: a static asset's path runs through
  // softlinks and a mount, and every softlink restarts the walk from the root
  // (ein/core#437). Both calls still check read access on the node itself.
  const entry = await config.vfs.resolvePath(access, vfsPath);
  const node = await config.vfs.get<FileAttrs>(access, entry);

  // Two shapes of a rendition nobody finished writing, both answered as absent and both
  // decided before the ETag and Cache-Control below — a 404 is not a cacheable rendition,
  // and answering `if-none-match` first would hand a browser that cached the bad response
  // a 304 forever.
  //
  // 404 is what the caller can actually act on: the UI's fallback chain already handles a
  // missing derivative by stepping down a level, and `generate-derivatives` treats both
  // shapes as absent and regenerates them.
  //
  //  - No `size` at all: `file-sync` never ran, so bytes were left half-written. `size` is
  //    declared non-optional on FileAttrs, and `size.toString()` below would throw.
  //
  //  - `size` of exactly 0: the converter produced nothing and `file-sync` recorded that
  //    honestly, so the node is self-consistent and no integrity sweep flags it. Served as a
  //    200 it is worse than a 404, because the fallback chain never fires: the browser mounts
  //    an empty `application/octet-stream` over the poster and reports a decode error. Scoped
  //    to renditions — a top-level original may legitimately be empty (someone uploads a
  //    0-byte file), and that keeps its honest 200.
  //
  // Deliberately not thrown as NodeNotFoundError: get-default catches that for the SPA
  // fallback, which would answer a broken image with index.html.
  const size = node.attrs.size;
  if (typeof size !== 'number' || (size === 0 && node.attrs.sourceId)) {
    return new Response(null, { status: 404, headers: responseHeaders });
  }

  const etag = node.attrs.sha256 ? `"${node.attrs.sha256}"` : undefined;

  if (etag) {
    responseHeaders.set('ETag', etag);
  }

  // A rendition has a stable URL and bytes that change only when something explicitly
  // regenerates them — a rotate in the lightbox, `regenerate -f`. Originals get nothing:
  // they are the thing being protected, and a wrong lifetime there is not recoverable by
  // regenerating.
  //
  // Without a lifetime a browser has neither Cache-Control nor Last-Modified to compute
  // freshness from, so every grid tile and every hover preview costs at least a 304 round
  // trip. An hour is short enough that another session's regeneration surfaces on its own,
  // and the session that *caused* one busts the URL itself.
  if (node.attrs.sourceId) {
    responseHeaders.set('Cache-Control', 'private, max-age=3600, stale-while-revalidate=86400');
  }

  // A file whose name is its content's hash, like a module's UI bundle under /var/cache/ui:
  // new bytes get a new name, so these never change.
  if (node.attrs.immutable === true) {
    responseHeaders.set('Cache-Control', 'private, max-age=31536000, immutable');
  }

  // Conditional request. The headers go out with the 304 too: a revalidation that answers
  // "unchanged" and carries no Cache-Control leaves the entry stale the moment it lands, so
  // the next request revalidates again and the lifetime above never applies to the requests
  // it exists for. It also carries whatever cookie headers getSession built.
  if (etag && req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: responseHeaders });
  }

  const range = parseByteRange(req.headers.get('range'), size);

  responseHeaders.set('Content-Type', node.attrs.mimetype || 'application/octet-stream');
  // Without this, <video> cannot seek: the browser has to buffer the whole
  // transcode before a scrub works
  responseHeaders.set('Accept-Ranges', 'bytes');

  if (range === 'unsatisfiable') {
    responseHeaders.set('Content-Range', `bytes */${size}`);
    return new Response(null, { status: 416, headers: responseHeaders });
  }

  if (!range) {
    responseHeaders.set('Content-Length', size.toString());

    if (req.method === 'HEAD') {
      return new Response(null, { headers: responseHeaders });
    }

    const fh = await config.vfs.open(access, entry, { mode: 'r' });
    return new Response(fileBody(fh, size, req.signal), { headers: responseHeaders });
  }

  const length = range.end - range.start + 1;
  responseHeaders.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
  responseHeaders.set('Content-Length', length.toString());

  if (req.method === 'HEAD') {
    return new Response(null, { status: 206, headers: responseHeaders });
  }

  const fh = await config.vfs.open(access, entry, { mode: 'r' });
  try {
    await fh.seek(range.start, ResourceSeekMode.Start);
    return new Response(fileBody(fh, length, req.signal), { status: 206, headers: responseHeaders });
  } catch (error) {
    await fh.close();
    throw error;
  }
}
