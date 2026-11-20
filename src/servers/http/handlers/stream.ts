/**
 * Streams over HTTP, for whoever may read the stream's node:
 *
 *   GET /file/<stream>    its bytes from its latest start point on, as its writer writes them; of a
 *                         stream of pictures, one picture
 *
 * A page watches a stream live by reading it over `GET /file/…`: a camera's fragmented MP4, its
 * header first, into a MediaSource.
 */

import { createLogger } from '../../../managers/logger/mod.ts';
import type { Access } from '../../../lib/access/types.ts';
import type { NodeReference } from '../../../vfs/types.ts';
import type { HttpServerConfig } from '../types.ts';

const logger = createLogger('http-stream');

/** DLNA's flags for a live stream: no seeking (OP=00), made for the reader (CI=1), streamed. */
export const DLNA_LIVE_FEATURES = 'DLNA.ORG_OP=00;DLNA.ORG_CI=1;DLNA.ORG_FLAGS=01700000000000000000000000000000';

/**
 * The stream `ref` names as its bytes come, from its writer's latest start point (or now) until its
 * writer stops or the reader goes; a reader who falls too far behind is let go, and its response
 * ends. A DLNA renderer that asked how it may be read is told it is live and cannot be sought in.
 */
export async function streamBodyResponse(
  config: HttpServerConfig,
  access: Access,
  ref: NodeReference,
  mimetype: string | undefined,
  responseHeaders: Headers,
  head: boolean,
): Promise<Response> {
  responseHeaders.set('Content-Type', mimetype || 'application/octet-stream');
  responseHeaders.set('Cache-Control', 'no-store');
  if (responseHeaders.has('contentFeatures.dlna.org')) responseHeaders.set('contentFeatures.dlna.org', DLNA_LIVE_FEATURES);
  if (head) return new Response(null, { headers: responseHeaders });
  const handle = await config.vfs.open(access, ref, { mode: 'r' });
  const done = new AbortController();
  const close = () => {
    done.abort();
    void handle.close().catch(() => {});
  };
  const body = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      try {
        const chunk = await handle.read(STREAM_CHUNK, done.signal);
        if (chunk.length > 0) return controller.enqueue(chunk);
      } catch (error) {
        if (!done.signal.aborted) logger.info('a stream ended under its reader', { path: typeof ref === 'string' ? ref : ref.absPath, error: String(error) });
      }
      close();
      controller.close();
    },
    cancel: close,
  });
  return new Response(body, { headers: responseHeaders });
}

/** The most one chunk of a stream's response takes. */
const STREAM_CHUNK = 256 * 1024;
