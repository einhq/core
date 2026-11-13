/** Sign-in links in the browser: the address one is sent as, and the page that opens it. */

/** The page that opens a sign-in link (`/invite/<token>`). */
const INVITE_PREFIX = '/invite/';

/** The address a sign-in link is sent as, on this site. */
export const inviteUrl = (origin: string, token: string): string => `${origin}${INVITE_PREFIX}${token}`;

/** Whether `pathname` is the page that opens a sign-in link. */
export const isInvitePage = (pathname: string): boolean => pathname.startsWith(INVITE_PREFIX) && pathname.length > INVITE_PREFIX.length;
