import { isVisitor } from '../../../lib/access/mod.ts';
import { getSession } from '../session.ts';
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
