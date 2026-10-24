import { basename } from '@std/path';
import { FileAttrs } from '../../../vfs/types/file.ts';
import { NodeAccessDeniedError, NodeNotFoundError } from '../../../vfs/mod.ts';
import { ARCHIVE_MAX_ENTRIES, ArchiveEntry, ArchiveTicketStore, uniqueEntryName } from '../archive-tickets.ts';
import { getSession, refusesGuest } from '../session.ts';
import { HttpServerConfig } from '../types.ts';

/**
 * POST /archive — park a list of paths and answer with the URL that downloads them as one zip.
 *
 * Body: `{ paths: string[], name?: string }`. Response: `{ url, filename, count, expiresAt }`.
 *
 * The paths are resolved here rather than at download time so a selection containing
 * something unreadable fails as a 403/404 the UI can show. A zip is streamed, so by the time
 * `get-archive` runs there is no status code left to fail with.
 */
export async function handlePostArchive(config: HttpServerConfig, req: Request, tickets: ArchiveTicketStore): Promise<Response> {
  const { responseHeaders, access } = await getSession(config, req.headers, { create: false });
  if (await refusesGuest(config, access)) return new Response('sign in first', { status: 401, headers: responseHeaders });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response('invalid JSON body', { status: 400, headers: responseHeaders });
  }

  const request = body as { paths?: unknown; name?: unknown };
  const paths = request.paths;

  if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string')) {
    return new Response('paths must be an array of strings', { status: 400, headers: responseHeaders });
  }

  if (paths.length === 0) {
    return new Response('paths is empty', { status: 400, headers: responseHeaders });
  }

  if (paths.length > ARCHIVE_MAX_ENTRIES) {
    return new Response(`at most ${ARCHIVE_MAX_ENTRIES} paths per archive`, { status: 413, headers: responseHeaders });
  }

  const entries: ArchiveEntry[] = [];
  const used = new Set<string>();

  for (const path of paths as string[]) {
    let node;
    try {
      node = await config.vfs.get<FileAttrs>(access, path);
    } catch (err) {
      // Answered per path: a selection is assembled from a listing, so the useful report is
      // which member of it went away or was never readable, not that the batch failed.
      if (err instanceof NodeNotFoundError) {
        return new Response(`not found: ${path}`, { status: 404, headers: responseHeaders });
      }
      if (err instanceof NodeAccessDeniedError) {
        return new Response(`forbidden: ${path}`, { status: 403, headers: responseHeaders });
      }
      throw err;
    }

    if (typeof node.attrs.size !== 'number') {
      return new Response(`not a file: ${path}`, { status: 400, headers: responseHeaders });
    }

    // The entry name comes from the path, never from the client: a name off the wire is
    // free to be `../` and would write outside the extraction directory.
    entries.push({
      path,
      name: uniqueEntryName(basename(path), used),
      modified: node.props.modtime.timestamp,
    });
  }

  const { token, ticket } = tickets.issue(entries, archiveFilename(request.name));

  return new Response(
    JSON.stringify({ url: `/archive/${token}`, filename: ticket.filename, count: entries.length, expiresAt: ticket.expiresAt }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/**
 * What the browser saves the archive under.
 *
 * A caller-supplied name is reduced to one path segment of safe characters — it ends up in a
 * `Content-Disposition` header and then in a filename on someone's disk, and neither location
 * should have to cope with a quote, a newline or a separator.
 */
function archiveFilename(name: unknown): string {
  if (typeof name === 'string') {
    const cleaned = basename(name).replace(/\.zip$/i, '').replace(/[^\p{L}\p{N} ._-]/gu, '-').replace(/^[.\s-]+|[.\s-]+$/g, '').slice(0, 80);
    if (cleaned) {
      return `${cleaned}.zip`;
    }
  }

  const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '').replaceAll('-', '').replace('T', '-');
  return `ein-${stamp}.zip`;
}
