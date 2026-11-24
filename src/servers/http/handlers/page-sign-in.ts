/**
 * `GET /__page/<ticket>` — a browser that cannot sign in, the media service's rendering a page for
 * a screen, signed in with a page ticket (`pageSignIn`): a session of its own with the ticket's
 * access, read-only as a share link's visitor reads, and sent on to the ticket's page. The session's
 * link names the page, so the Web UI keeps the browser on it as it keeps a share link's visitor on
 * what the link opens. A ticket opens one session, once, which ends when the page's stream does
 * (`endPageSignIn`) and with this process.
 */

import type { Access } from '../../../lib/access/types.ts';
import { openPageSession } from '../session.ts';
import type { HttpServerConfig } from '../types.ts';

/** What the link in a page ticket's session is called: it names no share link, and ends with the session. */
const PAGE_LINK_ID = 'page';

const refused = () => new Response('this page ticket has run out or was used', { status: 403, headers: { 'Cache-Control': 'no-store' } });

export async function handlePageSignIn(config: HttpServerConfig, req: Request, url: URL): Promise<Response> {
  const ticket = decodeURIComponent(url.pathname.slice('/__page/'.length));
  const devices = config.devices;
  const opened = devices?.takePageTicket(ticket);
  if (!devices || !opened) return refused();
  const { uid, gid, gids } = opened.access;
  const access: Access = { uid, gid, gids: [...gids], link: { id: PAGE_LINK_ID, route: opened.route } };
  const { responseHeaders: headers, sessionPath } = await openPageSession(config, req.headers, access);
  if (!await devices.pageOpened(ticket, sessionPath)) return refused();
  headers.set('Location', opened.route);
  headers.set('Cache-Control', 'no-store');
  return new Response(null, { status: 303, headers });
}
