/**
 * What an invitation opens, to any page of any origin, since the token is the credential:
 *
 *   GET /__invite/<token>   { nodes: [{ path, mode }], expires } (`InvitationLink`), or 404 once it
 *                           opens nothing: unknown, expired, turned off, or its creator gone
 *
 * Each node opens over a WebSocket at `/file/<path>?mode=<mode>&invite=<token>`: a stream `r` or `w`, a socket `rw`.
 */

import type { InvitationLink } from '../../../lib/api/invitation.ts';
import { invitationByToken, invitationNodes } from '../../../lib/invitations/mod.ts';
import type { HttpServerConfig } from '../types.ts';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Max-Age': '600' };

export async function handleGetInvite(config: HttpServerConfig, req: Request, url: URL): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Allow-Headers': '*' } });
  const headers = { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const token = decodeURIComponent(url.pathname.slice('/__invite/'.length));
  const found = await invitationByToken(config.vfs, token);
  if (!found) return new Response(JSON.stringify({ error: 'this invitation does not open anything any more' }), { status: 404, headers });
  const answer: InvitationLink = { nodes: await invitationNodes(config.vfs, found.node.attrs), expires: new Date(found.node.attrs.expiresAt).toISOString() };
  return new Response(req.method === 'HEAD' ? null : JSON.stringify(answer satisfies InvitationLink), { headers });
}
