import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { accessOfUid } from '../../../lib/auth/member-gids.ts';
import { sameToken } from '../../../lib/token/mod.ts';
import { parseTrackerPath, readTrackerToken } from '../../../lib/track/tracker.ts';
import { createLogger } from '../../../managers/logger/mod.ts';
import { TrackHandle } from '../../../registries/track/mod.ts';
import { clientAddress } from '../client-address.ts';
import { readTrackerRequest } from '../tracker-protocols.ts';
import { HttpServerConfig } from '../types.ts';

const logger = createLogger('http-tracker');

/**
 * GET|POST /tracker/<track id>.<token> — a phone or GPS tracker posts its fixes, without a session.
 *
 * The token is the track's own (`track-token`), and the points are appended as the track's owner.
 * Every protocol `tracker-protocols.ts` reads is taken at the one URL, so the URL is the whole of a
 * phone's setup. A request without a fix is answered 200, as trackers expect for a ping. Response:
 * {appended: n, skipped: n}.
 *
 * A token that does not open the track, an unknown track and an owner who may no longer sign in all
 * get the same 403, logged with the client's address.
 */
export async function handleTracker(config: HttpServerConfig, req: Request, url: URL, remoteAddr: Deno.Addr): Promise<Response> {
  const link = parseTrackerPath(url.pathname);
  const refuse = (reason: string) => {
    logger.warn('tracker post refused', { reason, track: link?.trackId, from: clientAddress(req.headers, remoteAddr) });
    return new Response('Forbidden', { status: 403 });
  };
  if (!link) return refuse('not a tracker link');

  const path = (await config.vfs.resolveIdPaths(ADMIN_ACCESS, [link.trackId])).get(link.trackId)?.[0];
  const record = path ? await readTrackerToken(config.vfs, path) : undefined;
  if (!path || !record || !sameToken(record.attrs.token, link.token)) return refuse('no such tracker token');

  const track = await config.vfs.get(ADMIN_ACCESS, path);
  const access = await accessOfUid(config.vfs, track.props.uid);
  if (!access) return refuse("the track's owner has no active account");

  const fixes = readTrackerRequest(url, req.headers.get('content-type') ?? '', req.method === 'POST' ? await req.text() : '');
  if ('error' in fixes) return new Response(fixes.error, { status: 400 });

  const json = (appended: number) =>
    new Response(JSON.stringify({ appended, skipped: fixes.points.length - appended }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (fixes.points.length === 0) return json(0);

  const handle = await config.vfs.open(access, path, { mode: 'a' });
  try {
    if (!(handle instanceof TrackHandle)) return new Response('not a track node', { status: 400 });
    return json(await handle.appendPoints(fixes.points));
  } catch (error) {
    return new Response(error instanceof Error ? error.message : String(error), { status: 400 });
  } finally {
    await handle.close();
  }
}
