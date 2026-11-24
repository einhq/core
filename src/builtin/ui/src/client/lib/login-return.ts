/** A stand-in origin to resolve `next` against; only whether the result stays on it matters. */
const SITE = 'http://ein.invalid';

/**
 * Where to go after signing in: the `next` parameter the auth redirect left on
 * the login URL, when it is a path on this site, else the dashboard. `next` is
 * resolved as the browser will resolve it, since the URL parser drops tabs and
 * newlines and reads `\` as `/`: `/\t/evil.example` is `//evil.example`, another
 * site. What comes back is the resolved path, so it cannot be read differently
 * when it is followed.
 */
export function loginReturnPath(params: URLSearchParams): string {
  const next = params.get('next');
  if (!next?.startsWith('/')) return '/';
  const url = new URL(next, SITE);
  const path = url.pathname + url.search + url.hash;
  // `/.//evil.example` resolves to the path `//evil.example`, which on its own names another site.
  if (url.origin !== SITE || path.startsWith('//')) return '/';
  if (/^\/login(?:[/?#]|$)/.test(path)) return '/';
  return path;
}

/** The login URL for a visitor sent there from `path` (path, query and hash). */
export function loginUrlFor(path: string): string {
  return path === '/' ? '/login' : `/login?next=${encodeURIComponent(path)}`;
}
