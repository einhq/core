/**
 * Share links in the browser: the address one is sent as, and which pages a visitor holding one may
 * see without signing in.
 */

/** The page that opens a share link (`/s/<token>`). */
const SHARE_LINK_PREFIX = '/s/';

/** The address a share link is sent as, on this site. */
export const shareLinkUrl = (origin: string, token: string): string => `${origin}${SHARE_LINK_PREFIX}${token}`;

/** Whether `pathname` is the page that opens a share link. */
export const isShareLinkPage = (pathname: string): boolean => pathname.startsWith(SHARE_LINK_PREFIX) && pathname.length > SHARE_LINK_PREFIX.length;

const decoded = (path: string): string => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

/**
 * Whether `pathname` shows what `route` shows or something inside it: the route itself, or one that
 * continues it past a slash, encoded or not — an album's route carries its node path encoded, and a
 * folder inside the album is the same route with the longer path.
 */
export const withinRoute = (pathname: string, route: string): boolean => {
  const here = decoded(pathname).replace(/\/+$/, '');
  const base = decoded(route).replace(/\/+$/, '');
  return here === base || here.startsWith(`${base}/`);
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a link may be set to work for, from now; null for no end date. */
export const LINK_EXPIRIES: { label: string; days: number | null }[] = [
  { label: '1 day', days: 1 },
  { label: '1 week', days: 7 },
  { label: '30 days', days: 30 },
  { label: '3 months', days: 91 },
  { label: '1 year', days: 365 },
  { label: 'No end date', days: null },
];

/** A day as the dialog writes it: `11 Nov`, and the year too when it is not this one. */
const shortDate = (at: number, now: number): string =>
  new Date(at).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(new Date(at).getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}),
  });

/** When a link stops working, in the dialog's words. */
export const expiryText = (expiresAt: number | undefined, now = Date.now()): string => {
  if (expiresAt === undefined) return 'Never expires';
  const left = expiresAt - now;
  if (left <= 0) return 'Expired';
  const days = Math.ceil(left / DAY_MS);
  return days === 1 ? 'Expires within a day' : `Expires in ${days} days, on ${shortDate(expiresAt, now)}`;
};

/** How often a link was opened and when last, in the dialog's words. */
export const openedText = (opened: number, lastOpenedAt: number | undefined, now = Date.now()): string => {
  if (opened === 0 || lastOpenedAt === undefined) return 'Not opened yet';
  const days = Math.floor((now - lastOpenedAt) / DAY_MS);
  const when = days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 7 ? `${days} days ago` : `on ${shortDate(lastOpenedAt, now)}`;
  return `Opened ${opened === 1 ? 'once' : `${opened} times`}, last ${when}`;
};
