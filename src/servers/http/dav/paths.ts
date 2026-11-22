/**
 * WebDAV's addresses: `/dav/<path>` is `/<path>` in the tree, each segment percent-encoded on its
 * own, as `/file/` URLs are.
 */

/** Where WebDAV is served. */
const DAV_PREFIX = '/dav';

/** Whether a URL path is WebDAV's: `/dav` itself or anything under `/dav/`, not `/davx`. */
export const isDavPath = (pathname: string): boolean => pathname === DAV_PREFIX || pathname.startsWith(`${DAV_PREFIX}/`);

/**
 * The tree path a WebDAV URL path names, or undefined when it names none: a segment that does not
 * decode, or decodes to `.`, `..`, or something holding `/` or NUL. Empty segments are skipped, so
 * `/dav`, `/dav/` and `/dav//` are all the root.
 */
export function davPath(pathname: string): string | undefined {
  if (!isDavPath(pathname)) return undefined;
  const segments: string[] = [];
  for (const raw of pathname.slice(DAV_PREFIX.length).split('/')) {
    if (raw === '') continue;
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\0')) return undefined;
    segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

/** The WebDAV URL path of a tree path, as a listing's `href`; a collection's ends in `/`. */
export function davHref(path: string, collection: boolean): string {
  const encoded = path.split('/').filter((segment) => segment !== '').map(encodeURIComponent).join('/');
  const href = encoded === '' ? `${DAV_PREFIX}/` : `${DAV_PREFIX}/${encoded}`;
  return collection && !href.endsWith('/') ? `${href}/` : href;
}

/** Where a `Destination` header points: a tree path, or why it is refused (RFC 4918's 400 and 502). */
type Destination = { path: string } | { refused: 400 | 502 };

/**
 * The tree path a `Destination` header names, an absolute URL or a path, read against the
 * request's URL. Its scheme and host are not compared with the request's: behind a TLS proxy the
 * client names the proxy's, and EiN is reached over plain HTTP under another. A URL outside
 * `/dav/` is another namespace (502); one that does not parse, or names no path, is a bad request.
 */
export function destination(header: string | null, url: URL): Destination {
  if (header === null || header.trim() === '') return { refused: 400 };
  let target: URL;
  try {
    target = new URL(header.trim(), url);
  } catch {
    return { refused: 400 };
  }
  if (!isDavPath(target.pathname)) return { refused: 502 };
  const path = davPath(target.pathname);
  return path === undefined ? { refused: 400 } : { path };
}
