import { parseByteRange } from '../../../lib/utils/mod.ts';
import { ResourceSeekMode } from '../../../registries/types.ts';
import type { Access } from '../../../lib/access/mod.ts';
import type { AccessVia } from '../../../lib/api/mod.ts';
import { type Node, type NodeEntry, NodeNotFoundError } from '../../../vfs/mod.ts';
import { NODE_TYPE_STREAM } from '../../../vfs/types/stream.ts';
import { FileAttrs } from '../../../vfs/types/file.ts';
import { UI_CACHE_PATH } from '../../../builtin/ui/lib/ui-cache.ts';
import type { DownloadLog } from '../download-log.ts';
import { getSession, refusesGuest } from '../session.ts';
import { HttpServerConfig } from '../types.ts';
import { fileBody } from './file-body.ts';
import { streamBodyResponse } from './stream.ts';

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
   * reads them whether or not visitors may browse. The modules' pages, `ui-build`'s bundles and
   * manifest under `/var/cache/ui`, are the site's too: a page open to anyone, such as a browser
   * display's, is one of them.
   */
  site?: boolean;
  /** Where a read of an original is recorded as a download, with the client's address. */
  downloads?: DownloadLog;
  from?: string;
  /** How the client reached EiN, as the download is recorded; `http` when not given. */
  via?: AccessVia;
};

type ServeOptions = GetFileOptions & {
  sessionPath?: string;
  /** The node at the path itself, never the rendition of the picture its file shows (`?original`). */
  original?: boolean;
};

const RENDITION_PATH = /^(.+)\/thumbnails\/([^/]+)$/;

/**
 * What a file opened on its own may do: nothing that runs. `sandbox` gives the page an origin of its
 * own with no scripts, so a member's file cannot reach the viewer's session or `/__shell`
 * (ein/core#1350). A page loading the file as an image, a video or by `fetch` ignores it.
 */
const FILE_POLICY = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";

/**
 * What a page of the site, the shell among them, may load: scripts from EiN itself and Google's Cast
 * sender (cast-sender.ts loads it from www.gstatic.com), so injected markup runs nothing, and only
 * EiN's own pages may frame it. `'wasm-unsafe-eval'` lets a module's page compile WebAssembly
 * without letting any script `eval` text. Pictures may come from anywhere, since a map's tiles come
 * from whatever server its layer names; styles may be inline, as Mantine writes them. A page may
 * connect to another server, such as another EiN whose invitation it was handed (`/__invite/`).
 */
const PAGE_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' https://www.gstatic.com",
  "connect-src 'self' https: wss: http: ws:",
  "style-src 'self' 'unsafe-inline'",
  'img-src * data: blob:',
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

/** Types a browser opens as a page of its own: HTML, and XML, which may be XHTML. SVG is a picture and keeps its type. */
const isPageType = (type: string): boolean => type === 'text/html' || type === 'text/xml' || type === 'application/xml' || (type.endsWith('+xml') && type !== 'image/svg+xml');

/**
 * The headers a file from the tree goes out with, which are never more than its stored mimetype
 * allows: a page type is sent as plain text, so it shows its source, and nothing is sniffed. A PDF is
 * left out of the sandbox: the browser's own viewer shows it, apart from the page, and not every
 * browser's viewer runs in a sandboxed one.
 */
function setFileHeaders(headers: Headers, mimetype: string | undefined): void {
  const type = (mimetype ?? '').split(';')[0].trim().toLowerCase();
  headers.set('Content-Type', !type ? 'application/octet-stream' : isPageType(type) ? 'text/plain; charset=utf-8' : mimetype ?? type);
  headers.set('X-Content-Type-Options', 'nosniff');
  if (type !== 'application/pdf') headers.set('Content-Security-Policy', FILE_POLICY);
}

/**
 * For a file's own rendition, `<file>/thumbnails/<name>`, the same rendition of the picture its
 * `shown` attr names (a restored copy among its versions); undefined when the file shows itself,
 * or that picture has no rendition of the name, so the file's own is served.
 */
async function shownRendition(
  config: HttpServerConfig,
  access: Access,
  vfsPath: string,
  node: Node<FileAttrs>,
): Promise<{ entry: NodeEntry; node: Node<FileAttrs> } | undefined> {
  const match = node.attrs.sourceId ? RENDITION_PATH.exec(vfsPath) : null;
  if (!match) return undefined;
  const [, filePath, name] = match;
  const file = await config.vfs.get<FileAttrs>(access, filePath).catch(() => undefined);
  const shown = file?.attrs.shown;
  if (!file || typeof shown !== 'string' || node.attrs.sourceId !== file.id) return undefined;
  if (shown.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return undefined;
  try {
    const picture = await config.vfs.get<FileAttrs>(access, `${filePath}/${shown}`);
    if (picture.attrs.sourceId !== file.id) return undefined;
    const entry = await config.vfs.resolvePath(access, `${filePath}/${shown}/thumbnails/${name}`);
    const rendition = await config.vfs.get<FileAttrs>(access, entry);
    return rendition.attrs.size ? { entry, node: rendition } : undefined;
  } catch {
    return undefined;
  }
}

export async function handleGetFile(config: HttpServerConfig, req: Request, url: URL, opts: GetFileOptions = {}): Promise<Response> {
  const vfsPath = decodeURIComponent(url.pathname.replace('/file', ''));
  // An encoded `..` survives the URL's own normalising: a site path would climb out of the site.
  if (vfsPath.split('/').some((segment) => segment === '.' || segment === '..')) throw new NodeNotFoundError(vfsPath);
  const ticket = url.searchParams.get('ticket');
  if (ticket !== null) return await ticketFile(config, req, url, vfsPath, ticket);
  const { responseHeaders, access, sessionPath } = await getSession(config, req.headers, { create: opts.createSession === true });
  const site = opts.site || vfsPath.startsWith(`${UI_CACHE_PATH}/`);
  if (!site && await refusesGuest(config, access)) return new Response('sign in first', { status: 401, headers: responseHeaders });
  return await serveFile(config, req, vfsPath, access, responseHeaders, { ...opts, sessionPath, original: url.searchParams.has('original') });
}

/**
 * A file read with a ticket a driver gave a device on the network (`fileTicket`): as the access the
 * ticket holds, without a session, and from any page, since a Cast device's player fetches from one.
 * A DLNA renderer that asks how the file may be read (`getcontentFeatures.dlna.org`) is told it may
 * seek by byte, and the transfer mode it asks for is granted.
 */
async function ticketFile(config: HttpServerConfig, req: Request, url: URL, vfsPath: string, ticket: string): Promise<Response> {
  const responseHeaders = new Headers({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges' });
  if (req.headers.get('getcontentfeatures.dlna.org') === '1') responseHeaders.set('contentFeatures.dlna.org', DLNA_FEATURES);
  const mode = req.headers.get('transfermode.dlna.org');
  if (mode && /^(Streaming|Interactive|Background)$/.test(mode)) responseHeaders.set('transferMode.dlna.org', mode);
  const access = config.devices?.fileTicketAccess(ticket, vfsPath);
  if (!access) return new Response('the ticket has run out or is for another file', { status: 403, headers: responseHeaders });
  return await serveFile(config, req, vfsPath, access, responseHeaders, { original: url.searchParams.has('original') });
}

/** DLNA's flags for a file: seeks by byte range (OP=01), not converted (CI=0), streamed or read in the background. */
const DLNA_FEATURES = 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';

/** What a page asks before it reads a file with a ticket and a `Range`: anyone may, the ticket decides. */
export const ticketPreflight = (): Response =>
  new Response(null, {
    status: 204,
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Allow-Headers': '*', 'Access-Control-Max-Age': '600' },
  });

/**
 * Answer a GET or HEAD of the file at `vfsPath` as `access`: its bytes, or the range asked for, with
 * the headers `setFileHeaders` allows; a stream's live bytes; 404 for a rendition nobody finished.
 */
export async function serveFile(
  config: HttpServerConfig,
  req: Request,
  vfsPath: string,
  access: Access,
  responseHeaders: Headers,
  opts: ServeOptions,
): Promise<Response> {
  const { sessionPath } = opts;
  // Resolved once for both the `get` and the `open` below: a static asset's path runs through
  // softlinks and a mount, and every softlink restarts the walk from the root
  // (ein/core#437). Both calls still check read access on the node itself.
  let entry = await config.vfs.resolvePath(access, vfsPath);
  let node = await config.vfs.get<FileAttrs>(access, entry);
  if (!opts.original) {
    const shown = await shownRendition(config, access, vfsPath, node);
    if (shown) ({ entry, node } = shown);
  }

  // A stream keeps no bytes: what is read of it is what its writer writes from now on. Its type
  // goes out as a file's does, so a stream a member writes cannot be a page that runs.
  if (node.type === NODE_TYPE_STREAM) {
    setFileHeaders(responseHeaders, node.attrs.mimetype);
    return await streamBodyResponse(config, access, entry, responseHeaders.get('Content-Type') ?? undefined, responseHeaders, req.method === 'HEAD');
  }

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

  // The site's own pages, the shell's document among them, are EiN's and go out as they are typed.
  if (opts.site) {
    responseHeaders.set('Content-Type', node.attrs.mimetype || 'application/octet-stream');
    if (isPageType((node.attrs.mimetype ?? '').split(';')[0].trim().toLowerCase())) responseHeaders.set('Content-Security-Policy', PAGE_POLICY);
  } else {
    setFileHeaders(responseHeaders, node.attrs.mimetype);
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

  // Without this, <video> cannot seek: the browser has to buffer the whole
  // transcode before a scrub works
  responseHeaders.set('Accept-Ranges', 'bytes');

  if (range === 'unsatisfiable') {
    responseHeaders.set('Content-Range', `bytes */${size}`);
    return new Response(null, { status: 416, headers: responseHeaders });
  }

  // A read from the start is a download; the requests a player seeks with are part of the one before.
  if (req.method === 'GET' && (!range || range.start === 0)) await opts.downloads?.file(access, sessionPath ?? '', opts.from, vfsPath, node, opts.via);

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
