import { formatDate } from './datetime.ts';

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

/** Where this tab keeps the share link it opened, so a screen whose session lapsed opens it again. */
const REMEMBERED_KEY = 'ein.shareLink';

/** How long after reopening a link the tab waits before trying again, so a link that keeps failing does not loop. */
const REOPEN_PAUSE_MS = 60_000;

type Remembered = { token: string; route: string; reopenedAt?: number };

const readRemembered = (): Remembered | undefined => {
  try {
    const value = JSON.parse(sessionStorage.getItem(REMEMBERED_KEY) ?? 'null');
    return value && typeof value.token === 'string' && typeof value.route === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
};

const writeRemembered = (value: Remembered | undefined): void => {
  try {
    if (value) sessionStorage.setItem(REMEMBERED_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(REMEMBERED_KEY);
  } catch {
    // Storage refused (a private window): the tab just does not reopen the link by itself.
  }
};

/** Keep the link this tab opened and the page it opens, for `linkToReopen`. */
export const rememberShareLink = (token: string, route: string): void => writeRemembered({ token, route });

/** Forget the link this tab opened: it no longer works, or someone signed in. */
export const forgetShareLink = (): void => writeRemembered(undefined);

/**
 * The token of the link this tab opened, when `pathname` is under the page it opens and the tab has
 * not tried it again within the last minute — what a screen whose session lapsed opens again rather
 * than asking to sign in. Marks the try.
 */
export const linkToReopen = (pathname: string, now = Date.now()): string | undefined => {
  const remembered = readRemembered();
  if (!remembered || !withinRoute(pathname, remembered.route)) return undefined;
  if (remembered.reopenedAt !== undefined && now - remembered.reopenedAt < REOPEN_PAUSE_MS) return undefined;
  writeRemembered({ ...remembered, reopenedAt: now });
  return remembered.token;
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
  formatDate(at, {
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
