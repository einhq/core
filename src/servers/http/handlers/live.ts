/**
 * `GET /live/<id>.mp4` and `/live/<id>.ts` — a live stream a driver serves a device on the network
 * (`serveLive`), and `/live/<id>/<name>` — a file of a set it serves (`serveFiles`): to whoever has
 * the path, with no session and from any origin, since a Cast device's player fetches it from a page
 * of its own. A stream runs until the reader goes, which cancels the body, or its source ends. A
 * DLNA renderer that asks how a stream may be read (`getcontentFeatures.dlna.org`) is told it is
 * live and cannot be sought in, and the transfer mode it asks for is granted.
 */

import type { LiveFormat } from '../../../managers/devices/types.ts';
import type { HttpServerConfig } from '../types.ts';

const MEDIA_TYPES: Record<LiveFormat, string> = { mp4: 'video/mp4', ts: 'video/mp2t' };

const PATH = /^\/live\/([0-9a-f]{64})\.(mp4|ts)$/;
const FILE = /^\/live\/([0-9a-f]{64})\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;

const CORS = { 'Access-Control-Allow-Origin': '*' };

/** DLNA's flags for a live stream: no seeking (OP=00), made for the reader (CI=1), streamed. */
const DLNA_LIVE_FEATURES = 'DLNA.ORG_OP=00;DLNA.ORG_CI=1;DLNA.ORG_FLAGS=01700000000000000000000000000000';

/** What a DLNA renderer is told of a live stream, when it asks. */
const dlnaHeaders = (req: Request): Record<string, string> => {
  const headers: Record<string, string> = {};
  if (req.headers.get('getcontentfeatures.dlna.org') === '1') headers['contentFeatures.dlna.org'] = DLNA_LIVE_FEATURES;
  const mode = req.headers.get('transfermode.dlna.org');
  if (mode && /^(Streaming|Interactive|Background)$/.test(mode)) headers['transferMode.dlna.org'] = mode;
  return headers;
};

export async function handleLive(config: HttpServerConfig, req: Request, url: URL): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Allow-Headers': '*', 'Access-Control-Max-Age': '600' },
    });
  }
  const file = FILE.exec(url.pathname);
  if (file && config.devices && (req.method === 'GET' || req.method === 'HEAD')) return await serveFile(config.devices, req, file[1], file[2]);
  const match = PATH.exec(url.pathname);
  if (!match || !config.devices || (req.method !== 'GET' && req.method !== 'HEAD')) return new Response('Not Found', { status: 404, headers: CORS });
  const [, id, format] = match as unknown as [string, string, LiveFormat];
  const headers = { ...CORS, ...dlnaHeaders(req), 'Content-Type': MEDIA_TYPES[format], 'Cache-Control': 'no-store' };
  // A player that asks what it is before it reads gets the answer without starting a reader.
  if (req.method === 'HEAD') return new Response(null, { headers });
  const body = await config.devices.openLive(id, format);
  if (!body) return new Response('this stream has ended', { status: 404, headers: CORS });
  return new Response(body, { headers });
}

async function serveFile(devices: NonNullable<HttpServerConfig['devices']>, req: Request, id: string, name: string): Promise<Response> {
  let file;
  try {
    file = await devices.liveFile(id, name);
  } catch (error) {
    // The file could not be made now, as when the media service is busy; a player asks again.
    return new Response(error instanceof Error ? error.message : String(error), { status: 503, headers: { ...CORS, 'Retry-After': '2' } });
  }
  if (!file) return new Response('Not Found', { status: 404, headers: CORS });
  const headers: Record<string, string> = { ...CORS, 'Content-Type': file.type, 'Cache-Control': 'no-store' };
  if (file.body instanceof Uint8Array) headers['Content-Length'] = String(file.body.length);
  if (req.method === 'HEAD') {
    if (file.body instanceof ReadableStream) await file.body.cancel();
    return new Response(null, { headers });
  }
  return new Response(file.body, { headers });
}
