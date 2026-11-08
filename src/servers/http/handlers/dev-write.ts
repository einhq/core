/**
 * What devices write over HTTP, at `/file/dev/<device>` and `/file/dev/<device>/<endpoint>`:
 *
 *   PUT|POST /file/dev/<device>           raw input for its driver: a fix, a GPX file, a webhook's body
 *   GET /file/dev/<device>?key=…&…        the same from a tracker that only sends GETs (OsmAnd): its query
 *   POST /file/dev/<device>/<endpoint>    a value: appended to a log or a track, or written to a control
 *
 * A device cannot sign in, so it carries its key (`device-key`): `Authorization: Bearer <key>`, or
 * `key=` in the query for a client that only takes a URL. The key opens the device's own folder for
 * these writes and nothing else; they are made as the device's owner, and its driver is told they
 * were the device's. Without a key a write is the signed-in session's, as every `/file` write is. A
 * GET without a key is a read, which `get-file` answers.
 *
 * A refused key is answered 403 and logged with the client's address, the same for a device that
 * has none and one that does not exist.
 */

import { basename } from '@std/path';
import { ADMIN_ACCESS } from '../../../lib/access/constants.ts';
import type { Access } from '../../../lib/access/types.ts';
import { accessOfUid } from '../../../lib/auth/member-gids.ts';
import { DEV_PATH } from '../../../lib/paths.ts';
import { readTrackerRequest } from '../../../lib/track/tracker-protocols.ts';
import { DeviceError, isDeviceKey } from '../../../managers/devices/mod.ts';
import { createLogger } from '../../../managers/logger/mod.ts';
import { LogHandle } from '../../../registries/log/log-handle.ts';
import { TrackHandle } from '../../../registries/track/track-handle.ts';
import { NodeNotFoundError } from '../../../vfs/errors.ts';
import { NODE_TYPE_CONTROL, NODE_TYPE_DEVICE } from '../../../vfs/types/device.ts';
import { NODE_TYPE_LOG } from '../../../vfs/types/log.ts';
import { clientAddress } from '../client-address.ts';
import { getSession } from '../session.ts';
import type { HttpServerConfig } from '../types.ts';

const logger = createLogger('http-dev');

/** The device and endpoint a `/file/dev/…` path names, or undefined for any other path. */
const devTarget = (pathname: string): { device: string; endpoint?: string; path: string } | undefined => {
  const path = decodeURIComponent(pathname.replace(/^\/file/, '')).replace(/\/+$/, '');
  if (!path.startsWith(`${DEV_PATH}/`)) return undefined;
  const parts = path.slice(DEV_PATH.length + 1).split('/');
  if (parts.length > 2 || parts.some((part) => part === '' || part.startsWith('.'))) return undefined;
  return { device: parts[0], endpoint: parts[1], path };
};

const json = (body: unknown, status = 200, headers: HeadersInit = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });

/** A log's entries from a body: JSON objects (one, a list, or one a line), a bare value kept as `{ value }`. */
const logEntries = (text: string): unknown[] => {
  const asEntry = (parsed: unknown): unknown => typeof parsed === 'object' && parsed !== null ? parsed : { value: parsed };
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.map(asEntry) : [asEntry(parsed)];
  } catch {
    return text.split('\n').filter((line) => line.trim()).map((line) => {
      try {
        return asEntry(JSON.parse(line));
      } catch {
        return { value: line.trim() };
      }
    });
  }
};

/**
 * A device's write, answered; undefined when the request is not one (another path, or a read),
 * which the `/file` handlers take.
 */
export async function handleDevWrite(config: HttpServerConfig, req: Request, url: URL, remoteAddr: Deno.Addr): Promise<Response | undefined> {
  const target = devTarget(url.pathname);
  if (!target || !config.devices) return undefined;
  const bearer = req.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const key = bearer ?? url.searchParams.get('key') ?? undefined;
  const reading = req.method === 'GET' || req.method === 'HEAD';
  if (reading && !key) return undefined;
  if (req.method !== 'GET' && req.method !== 'PUT' && req.method !== 'POST') return undefined;

  let access: Access;
  let responseHeaders: HeadersInit = {};
  if (key) {
    const refuse = (reason: string) => {
      logger.warn('device write refused', { reason, device: target.device, from: clientAddress(req.headers, remoteAddr) });
      return new Response('Forbidden', { status: 403 });
    };
    if (!(await isDeviceKey(config.vfs, target.device, key))) return refuse('not the device key');
    const device = await config.vfs.get(ADMIN_ACCESS, `${DEV_PATH}/${target.device}`);
    const owner = await accessOfUid(config.vfs, device.props.uid);
    if (!owner) return refuse("the device's owner has no active account");
    access = owner;
  } else {
    const session = await getSession(config, req.headers, { create: false });
    access = session.access;
    responseHeaders = session.responseHeaders;
  }

  const query = new URLSearchParams(url.searchParams);
  query.delete('key');
  const bytes = reading ? new Uint8Array(0) : new Uint8Array(await req.arrayBuffer());
  const contentType = req.headers.get('content-type') ?? '';
  const by = key ? `device:${target.device}` : undefined;

  try {
    const node = await config.vfs.get(access, target.path);
    if (!target.endpoint) {
      if (node.type !== NODE_TYPE_DEVICE) return undefined;
      const answer = await config.devices.input(access, target.path, { bytes, contentType, query: query.toString(), by });
      return json(answer, 200, responseHeaders);
    }

    const text = new TextDecoder().decode(bytes);
    if (node.type === NODE_TYPE_CONTROL) {
      return json(await config.devices.command(access, target.path, text), 200, responseHeaders);
    }
    if (node.type === NODE_TYPE_LOG) {
      const entries = logEntries(text);
      if (entries.length === 0) return new Response('empty body', { status: 400, headers: responseHeaders });
      const handle = await config.vfs.open(access, target.path, { mode: 'a' });
      try {
        if (!(handle instanceof LogHandle)) return new Response('not a log', { status: 400, headers: responseHeaders });
        for (const entry of entries) {
          const ts = (entry as { ts?: string }).ts;
          const at = ts ? new Date(ts) : undefined;
          await handle.appendAt(entry, at && !Number.isNaN(at.getTime()) ? at : undefined);
        }
      } finally {
        await handle.close();
      }
      return json({ appended: entries.length }, 200, responseHeaders);
    }
    if (node.type === 'track') {
      const fixes = readTrackerRequest(new URL(`http://device/?${query}`), contentType, text);
      if ('error' in fixes) return new Response(fixes.error, { status: 400, headers: responseHeaders });
      const handle = await config.vfs.open(access, target.path, { mode: 'a' });
      try {
        if (!(handle instanceof TrackHandle)) return new Response('not a track', { status: 400, headers: responseHeaders });
        const appended = await handle.appendPoints(fixes.points);
        return json({ appended, skipped: fixes.points.length - appended }, 200, responseHeaders);
      } finally {
        await handle.close();
      }
    }
    return new Response(`${basename(target.path)} is a ${node.type}, not an endpoint`, { status: 400, headers: responseHeaders });
  } catch (error) {
    if (error instanceof DeviceError) return new Response(error.message, { status: 400, headers: responseHeaders });
    if (error instanceof NodeNotFoundError && key) return new Response('Forbidden', { status: 403 });
    throw error;
  }
}
