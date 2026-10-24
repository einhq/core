/**
 * Where to go after signing in: the `next` parameter the auth redirect left on
 * the login URL, when it is a path on this site, else the dashboard. A value
 * such as `//evil.example` or `https://…` would leave the site, so only a single
 * leading slash is accepted.
 */
export function loginReturnPath(params: URLSearchParams): string {
  const next = params.get('next');
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  if (/^\/login(?:[/?#]|$)/.test(next)) return '/';
  return next;
}

/** The login URL for a visitor sent there from `path` (path, query and hash). */
export function loginUrlFor(path: string): string {
  return path === '/' ? '/login' : `/login?next=${encodeURIComponent(path)}`;
}
