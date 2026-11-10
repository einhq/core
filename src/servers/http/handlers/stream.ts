/**
 * A device's streams over HTTP, for whoever may read the stream's node:
 *
 *   GET /file/dev/<device>/<stream>      one frame of it now, as its driver gives it (a JPEG)
 *   GET /stream/dev/<device>/<stream>    a WebSocket to watch it live
 *
 * The live socket is opened by EiN to where the stream's driver says it is watched (a restreamer's,
 * with its credentials), and every message is passed on both ways as it is: what the messages are
 * is between the page and the driver. So the reader never reaches the restreamer itself, nor learns
 * its address or password.
 */

import { DEV_PATH } from '../../../lib/paths.ts';
import { DeviceError } from '../../../managers/devices/mod.ts';
import { createLogger } from '../../../managers/logger/mod.ts';
import type { Access } from '../../../lib/access/types.ts';
import { getSession, refusesGuest } from '../session.ts';
import type { HttpServerConfig } from '../types.ts';

const logger = createLogger('http-stream');

/** A frame of the stream at `path`, never cached: each one is the stream as it is now. */
export async function streamFrameResponse(config: HttpServerConfig, access: Access, path: string, responseHeaders: Headers, head: boolean): Promise<Response> {
  if (!config.devices) return new Response('devices are not running here', { status: 404, headers: responseHeaders });
  try {
    const frame = await config.devices.frame(access, path);
    responseHeaders.set('Content-Type', frame.type);
    responseHeaders.set('Content-Length', String(frame.bytes.length));
    responseHeaders.set('Cache-Control', 'no-store');
    return new Response(head ? null : frame.bytes, { headers: responseHeaders });
  } catch (error) {
    if (!(error instanceof DeviceError)) throw error;
    return new Response(error.message, { status: 502, headers: responseHeaders });
  }
}

/** `/stream/dev/<device>/<stream>`: the stream's live socket, passed through to its driver's. */
export async function handleStreamLive(config: HttpServerConfig, req: Request, url: URL): Promise<Response> {
  const { responseHeaders, access } = await getSession(config, req.headers, { create: false });
  if (await refusesGuest(config, access)) return new Response('sign in first', { status: 401, headers: responseHeaders });
  const path = decodeURIComponent(url.pathname.replace(/^\/stream/, '')).replace(/\/+$/, '');
  if (!path.startsWith(`${DEV_PATH}/`) || !config.devices) return new Response('Not Found', { status: 404, headers: responseHeaders });
  if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('a stream is watched over a WebSocket', { status: 426, headers: responseHeaders });
  }

  let live;
  try {
    live = await config.devices.live(access, path);
  } catch (error) {
    if (!(error instanceof DeviceError)) throw error;
    return new Response(error.message, { status: 502, headers: responseHeaders });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);
  // Deno's WebSocket takes headers in its options, which its type does not have.
  const upstream = new WebSocket(live.url, { headers: live.headers } as unknown as string[]);
  socket.binaryType = 'arraybuffer';
  upstream.binaryType = 'arraybuffer';
  // What the page says before the driver's socket is open waits for it.
  const waiting: (string | ArrayBuffer)[] = [];
  const closeBoth = (code = 1000, reason = '') => {
    for (const each of [socket, upstream]) {
      if (each.readyState === WebSocket.OPEN || each.readyState === WebSocket.CONNECTING) {
        try {
          each.close(code, reason);
        } catch { /* closing already */ }
      }
    }
  };
  // A code a peer may not send on (1005, 1006) is passed on as a plain close.
  const passable = (code: number) => code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;

  upstream.onopen = () => {
    for (const message of waiting.splice(0)) upstream.send(message);
  };
  upstream.onmessage = (event) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(event.data);
  };
  upstream.onclose = (event) => closeBoth(passable(event.code), event.reason);
  upstream.onerror = () => {
    logger.info('a stream could not be reached', { path });
    closeBoth(4502, 'the stream could not be reached');
  };
  socket.onmessage = (event) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(event.data);
    else if (upstream.readyState === WebSocket.CONNECTING) waiting.push(event.data);
  };
  socket.onclose = (event) => closeBoth(passable(event.code), event.reason);
  socket.onerror = () => closeBoth();
  return response;
}
