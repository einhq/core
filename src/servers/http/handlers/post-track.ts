import { TrackHandle } from '../../../registries/track/mod.ts';
import { getSession } from '../session.ts';
import { HttpServerConfig } from '../types.ts';

/**
 * POST /track/<vfs-path> — append coordinate points to a track node.
 *
 * Body: a JSON object, a JSON array of objects, or newline-delimited JSON,
 * each `{lat, lng, ts?, alt?, speed?, course?}`. A point without a `ts` is
 * timestamped on arrival. Response: {appended: n, skipped: n}.
 *
 * `skipped` is not an error: a fix is keyed by its timestamp, so a tracker that
 * re-uploads a buffer it already sent adds nothing rather than duplicating it.
 */
export async function handlePostTrack(config: HttpServerConfig, req: Request, url: URL): Promise<Response> {
  const { responseHeaders, access } = await getSession(config, req.headers, { create: false });
  const vfsPath = decodeURIComponent(url.pathname.replace('/track', ''));

  const text = await req.text();
  let entries: unknown[];
  try {
    const parsed = JSON.parse(text);
    entries = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Fall back to newline-delimited JSON
    try {
      entries = text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
    } catch {
      return new Response('invalid JSON body', { status: 400, headers: responseHeaders });
    }
  }

  if (entries.length === 0) {
    return new Response('empty body', { status: 400, headers: responseHeaders });
  }

  const handle = await config.vfs.open(access, vfsPath, { mode: 'a' });
  let appended: number;

  try {
    if (!(handle instanceof TrackHandle)) {
      return new Response('not a track node', { status: 400, headers: responseHeaders });
    }

    appended = await handle.appendPoints(entries as Parameters<TrackHandle['appendPoints']>[0]);
  } catch (error) {
    return new Response(error instanceof Error ? error.message : String(error), { status: 400, headers: responseHeaders });
  } finally {
    await handle.close();
  }

  return new Response(JSON.stringify({ appended, skipped: entries.length - appended }), {
    status: 200,
    headers: { ...responseHeaders, 'Content-Type': 'application/json' },
  });
}
