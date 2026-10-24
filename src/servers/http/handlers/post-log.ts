import { LogHandle } from '../../../registries/log/mod.ts';
import { getSession } from '../session.ts';
import { HttpServerConfig } from '../types.ts';

/**
 * POST /log/<vfs-path> — append JSON entries to a log node.
 *
 * Body: a JSON object, a JSON array of objects, or newline-delimited JSON.
 * If an entry carries a `ts` field its createdAt is backdated to it, so
 * tracker devices can upload buffered points. Response: {appended: n}.
 */
export async function handlePostLog(config: HttpServerConfig, req: Request, url: URL): Promise<Response> {
  const { responseHeaders, access } = await getSession(config, req.headers, { create: false });
  const vfsPath = decodeURIComponent(url.pathname.replace('/log', ''));

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
  try {
    if (!(handle instanceof LogHandle)) {
      return new Response('not a log node', { status: 400, headers: responseHeaders });
    }

    for (const entry of entries) {
      const ts = (entry as { ts?: string })?.ts;
      const createdAt = ts ? new Date(ts) : undefined;
      await handle.appendAt(entry, createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : undefined);
    }
  } finally {
    await handle.close();
  }

  return new Response(JSON.stringify({ appended: entries.length }), {
    status: 200,
    headers: { ...responseHeaders, 'Content-Type': 'application/json' },
  });
}
