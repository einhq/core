import { configure, ZipWriter } from '@zip-js/zip-js';
import { Access } from '../../../lib/access/mod.ts';
import { createLogger } from '../../../managers/logger/mod.ts';
import { NodeAccessDeniedError, NodeNotFoundError, NodePath } from '../../../vfs/mod.ts';
import { ArchiveTicket, ArchiveTicketStore } from '../archive-tickets.ts';
import { getSession, refusesGuest } from '../session.ts';
import { HttpServerConfig } from '../types.ts';

const logger = createLogger('http-archive');

// zip.js reaches for web workers to run its codecs off-thread, spawning them from a blob
// URL. Nothing here compresses, so the workers would do nothing but exist — and they would
// outlive each request, which the test harness's resource sanitizer counts as a leak.
configure({ useWebWorkers: false });

/**
 * GET /archive/<token> — stream the selection a `POST /archive` parked as one zip.
 *
 * Entries are stored, not deflated: the corpus is JPEG, HEIC and H.264, all of which are
 * already compressed, so deflate would spend CPU per byte to save approximately none.
 * `zip64` is on because a selection of video passes 4 GB without being unusual.
 *
 * The token names a list and confers nothing. Every file is checked and opened with the
 * access of the session making *this* request, so a token that leaks gives its holder
 * exactly what `GET /file/<path>` already would.
 */
export async function handleGetArchive(config: HttpServerConfig, req: Request, url: URL, tickets: ArchiveTicketStore): Promise<Response> {
  const { responseHeaders, access } = await getSession(config, req.headers, { create: false });
  if (await refusesGuest(config, access)) return new Response('sign in first', { status: 401, headers: responseHeaders });
  const token = decodeURIComponent(url.pathname.replace('/archive/', ''));
  const ticket = tickets.get(token);

  if (!ticket) {
    return new Response('archive expired or unknown', { status: 404, headers: responseHeaders });
  }

  // Resolved up front, before a byte of the response exists: this is the last point at
  // which a refusal can still be a status code. `POST /archive` resolved the same list, but
  // as whoever posted it — this pass is what makes the check apply to whoever downloads.
  for (const entry of ticket.entries) {
    try {
      await config.vfs.get(access, entry.path);
    } catch (err) {
      if (err instanceof NodeNotFoundError) {
        return new Response(`not found: ${entry.path}`, { status: 404, headers: responseHeaders });
      }
      if (err instanceof NodeAccessDeniedError) {
        return new Response(`forbidden: ${entry.path}`, { status: 403, headers: responseHeaders });
      }
      throw err;
    }
  }

  responseHeaders.set('Content-Type', 'application/zip');
  responseHeaders.set('Content-Disposition', contentDisposition(ticket.filename));
  // Built per request from whatever the files hold right now, with no length to resume
  // against and no ETag to revalidate with. Nothing may hold on to it.
  responseHeaders.set('Cache-Control', 'no-store');

  if (req.method === 'HEAD') {
    return new Response(null, { headers: responseHeaders });
  }

  // The zip is assembled into one side of this and served from the other. There is no
  // Content-Length either way: the size of an entry is known only once it has been written,
  // and by then its bytes are already on the wire.
  const zipOut = new TransformStream<Uint8Array, Uint8Array>();

  // A file can still go away between the check above and its turn to be read, and by then
  // there is no status code left. This second stage is what makes that visible: erroring it
  // truncates the download so the browser rejects it, where letting the zip finish would
  // hand over a well-formed archive quietly missing a file. `start` runs synchronously, so
  // `fail` is assigned before anything can reach it.
  let fail: (error: unknown) => void = () => {};
  const guard = new TransformStream<Uint8Array, Uint8Array>({
    start: (controller) => {
      fail = (error) => controller.error(error);
    },
  });

  // Deliberately not awaited: the writes only make progress as the client consumes the
  // body, which cannot start until this handler has returned it. Backpressure comes for
  // free — a stalled reader stalls the reads feeding the zip.
  void writeEntries(config, access, ticket, zipOut.writable).catch((error) => {
    logger.error('archive stream failed', { token, error });
    fail(error);
  });

  return new Response(zipOut.readable.pipeThrough(guard), { headers: responseHeaders });
}

async function writeEntries(
  config: HttpServerConfig,
  access: Access,
  ticket: ArchiveTicket,
  writable: WritableStream<Uint8Array>,
): Promise<void> {
  const zip = new ZipWriter(writable, { level: 0, zip64: true });

  for (const entry of ticket.entries) {
    // A rejected `add` is deliberately left un-closed. `close` writes the central directory
    // and ends the stream, which for a zip missing an entry means handing the client a
    // well-formed archive that is simply wrong; the caller errors the body instead.
    await zip.add(entry.name, fileStream(config, access, entry.path), { lastModDate: new Date(entry.modified) });
  }

  // The central directory lives at the end of a zip, so a stream that is never closed is
  // not an archive.
  await zip.close();
}

/**
 * The bytes of one file, opened when the zip writer first pulls on it.
 *
 * Lazy so that a hundred-file archive holds one open handle at a time rather than a hundred,
 * and so that failing to open is an error *of the entry* rather than of the loop above it.
 */
function fileStream(config: HttpServerConfig, access: Access, path: NodePath): ReadableStream<Uint8Array> {
  let handle: Awaited<ReturnType<HttpServerConfig['vfs']['open']>> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const release = async () => {
    const open = handle;
    handle = undefined;
    reader = undefined;
    await open?.close();
  };

  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      try {
        if (!reader) {
          handle = await config.vfs.open(access, path, { mode: 'r' });
          reader = handle.readable.getReader();
        }

        const { done, value } = await reader.read();

        if (done) {
          await release();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        await release();
        throw error;
      }
    },
    cancel: release,
  });
}

/**
 * `Content-Disposition` for a download.
 *
 * Both forms, per RFC 6266: `filename` is what a client that predates the encoded form
 * reads, and `filename*` carries the name a Swedish album title actually has. The plain form
 * is stripped to ASCII rather than dropped, since it is the fallback.
 */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replaceAll('"', '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
