import { isVisitor } from '../../../lib/access/mod.ts';
import { getSession, takeHandover } from '../session.ts';
import { HttpServerConfig } from '../types.ts';

/**
 * GET /__session — whether the request's cookie signs it in: 204 when it does, 401 when it names
 * no session, an ended one, or one that has not signed in.
 *
 * A session it finds gets its cookie written again with a fresh lifetime, which keeps the cookie
 * of a page that lives on without loading the document again (the shell) while it is used. None
 * is minted: the browser picks up a new session where it loads the document.
 */
export async function handleGetSession(config: HttpServerConfig, req: Request): Promise<Response> {
  const { responseHeaders, access } = await getSession(config, req.headers, { create: false, refresh: true });
  responseHeaders.set('cache-control', 'no-store');
  return new Response(null, { status: isVisitor(access) ? 401 : 204, headers: responseHeaders });
}

/**
 * POST /__session `{ "handover": "<token>" }` — after a sign-in, elevation or sign-out changed the
 * session's secret, take up the cookie of the new one: 204 with the cookie, or 403 when the token is
 * not the session's, already taken or too old. The page posts it with the token its own command
 * answered, so someone who planted the old cookie in the browser gets no use from it.
 */
export async function handlePostSession(config: HttpServerConfig, req: Request): Promise<Response> {
  const body = await req.json().catch(() => undefined) as { handover?: unknown } | undefined;
  const responseHeaders = typeof body?.handover === 'string' ? await takeHandover(config, req.headers, body.handover) : undefined;
  if (!responseHeaders) return new Response('no such handover', { status: 403, headers: { 'cache-control': 'no-store' } });
  responseHeaders.set('cache-control', 'no-store');
  return new Response(null, { status: 204, headers: responseHeaders });
}
