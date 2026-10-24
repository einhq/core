import { join } from '@std/path';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { NodeNotFoundError } from '../../../vfs/mod.ts';
import { isForwardedHttps } from '../session.ts';
import { HttpServerConfig } from '../types.ts';
import { handleGetFile } from './get-file.ts';

async function getVHostRoot(config: HttpServerConfig, req: Request): Promise<string> {
  const defaultRoot = join(config.rootPath, 'default');
  const hostHeader = req.headers.get('host');

  if (!hostHeader) {
    return defaultRoot;
  }

  // Strip port if present: "www.abc.com:8080" → "www.abc.com"
  const host = hostHeader.split(':')[0].toLowerCase();

  // Basic sanitization to prevent path traversal, also rejects bracketed IPv6
  if (!/^[a-z0-9.-]+$/.test(host)) {
    return defaultRoot;
  }

  // Unknown hosts (bare IPs, localhost, anything without its own site) get the default site
  const vhostRoot = join(config.rootPath, host);

  if (!await config.vfs.exists(ADMIN_ACCESS, vhostRoot)) {
    return defaultRoot;
  }

  return vhostRoot;
}

/**
 * Whether this request is a browser navigating to a document, as opposed to a
 * page fetching an asset or something probing a path.
 *
 * `Sec-Fetch-Mode` is the direct answer, but browsers attach the `Sec-Fetch-*`
 * headers only to potentially trustworthy origins, so when EiN is reached over
 * plain HTTP on the LAN it is absent. The `Accept` preference is the fallback:
 * a navigation asks for `text/html` first, while an image, a script or a
 * stylesheet never names it, and a client that accepts anything, or sends no
 * preference at all, is not a browser that will hold on to a cookie either.
 */
function isDocumentNavigation(req: Request): boolean {
  const mode = req.headers.get('sec-fetch-mode');

  if (mode) {
    return mode === 'navigate';
  }

  return req.headers.get('accept')?.includes('text/html') === true;
}

/** Where the document names the origin it was reached at: link previews need absolute URLs. */
const ORIGIN_PLACEHOLDER = '%EIN_ORIGIN%';

/**
 * The origin the client reached EiN at, from the `Host` header and, behind a TLS-terminating proxy,
 * its forwarded scheme. Empty for a host that is not a plain name or address with a port, which
 * leaves the document's URLs relative rather than echoing the header into the page.
 */
function requestOrigin(req: Request): string {
  const host = req.headers.get('host') ?? '';
  if (!/^([a-z0-9.-]+|\[[0-9a-f:.]+\])(:\d+)?$/i.test(host)) return '';
  return `${isForwardedHttps(req.headers) ? 'https' : 'http'}://${host.toLowerCase()}`;
}

/**
 * The vhost's document, with the request's origin in place of `ORIGIN_PLACEHOLDER`. It is read as a
 * GET even for `HEAD`, so that the length a `HEAD` answer gives is the rewritten page's. A 304 or a
 * byte range is passed on as it is.
 */
async function handleGetDocument(config: HttpServerConfig, req: Request, url: URL, createSession: boolean): Promise<Response> {
  const response = await handleGetFile(config, new Request(req, { method: 'GET' }), url, { createSession, site: true });
  if (response.status !== 200) return response;
  const body = new TextEncoder().encode((await response.text()).replaceAll(ORIGIN_PLACEHOLDER, requestOrigin(req)));
  const headers = new Headers(response.headers);
  headers.set('Content-Length', body.length.toString());
  return new Response(req.method === 'HEAD' ? null : body, { headers });
}

/** Paths under which a missing file is a 404 rather than the SPA document. */
const NO_FALLBACK_PREFIXES = ['/icons/'];

/** Paths a browser may keep for a day without asking again. */
const CACHED_PREFIXES = ['/icons/'];

export async function handleGetDefault(config: HttpServerConfig, req: Request, url: URL): Promise<Response> {
  const vhostRoot = await getVHostRoot(config, req);
  const indexPath = join(vhostRoot, 'index.html');
  const requested = url.pathname;

  // Map URL -> filesystem path
  if (url.pathname === '/' || url.pathname === '/index.html') {
    url.pathname = indexPath;
  } else {
    url.pathname = join(vhostRoot, url.pathname.slice(1));
  }

  // The document is where a browser picks up its session cookie, and it is
  // requested once per navigation rather than once per asset. Bundles and
  // images served from the same vhost root take the guest path and write
  // nothing — see GetFileOptions.
  //
  // Navigating is the other half of the test, and it is the one the SPA
  // fallback below needs: that fallback answers *any* unresolvable path with
  // the document, so a stale bookmark, a missing asset or a scanner would each
  // mint a session node the client can never present again.
  const navigation = isDocumentNavigation(req);
  const createSession = navigation && url.pathname === indexPath;

  try {
    if (url.pathname === indexPath) {
      return await handleGetDocument(config, req, url, createSession);
    }
    const response = await handleGetFile(config, req, url, { createSession, site: true });
    // A named icon only changes with the icon set, and every page draws twenty of them.
    if (response.ok && CACHED_PREFIXES.some((prefix) => requested.startsWith(prefix))) {
      response.headers.set('Cache-Control', 'public, max-age=86400');
    }
    return response;
  } catch (error) {
    if (error instanceof NodeNotFoundError) {
      // An icon that is not there is a wrong name in configuration, not a page:
      // the document in its place would draw nothing and hide the mistake.
      if (NO_FALLBACK_PREFIXES.some((prefix) => requested.startsWith(prefix))) {
        return new Response('Not Found', { status: 404 });
      }
      // SPA fallback: serve index.html from the SAME vhost
      url.pathname = indexPath;
      return await handleGetDocument(config, req, url, navigation);
    }

    throw error;
  }
}
