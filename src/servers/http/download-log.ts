/**
 * Downloads over HTTP, for the access log: `GET /file/` of an original and `GET /archive/`.
 */

import { basename, dirname } from '@std/path';
import { type Access, isGuest } from '../../lib/access/mod.ts';
import { type AccessInput, isLoggedDownload, type Node, type NodePath, type NodeVFS, recordAccess } from '../../vfs/mod.ts';

/**
 * How long after a session's read of a file is logged its next reads of the same file are not: a
 * video plays and seeks with a request per jump, and a grid shows the same original again and again.
 */
const DOWNLOAD_REPEAT_MS = 10 * 60_000;

/** Above this many remembered reads the expired ones are swept. */
const SWEEP_AT = 10_000;

/** The folder every path in `paths` lies in. */
const commonFolder = (paths: NodePath[]): NodePath => {
  const folders = paths.map((path) => dirname(path).split('/'));
  const shared = folders[0] ?? [''];
  let length = shared.length;
  for (const folder of folders) {
    let i = 0;
    while (i < length && i < folder.length && folder[i] === shared[i]) i++;
    length = i;
  }
  return shared.slice(0, length).join('/') || '/';
};

/**
 * The access log's record of HTTP downloads. Per server rather than module-level, as the archive
 * tickets are: the test harness starts several servers in one process.
 */
export class DownloadLog {
  readonly #seen = new Map<string, number>();

  constructor(private readonly vfs: NodeVFS) {}

  /** Who is downloading, as the access log records it: the account or link, the session and the address. */
  #who(access: Access, sessionPath: NodePath, from: string | undefined): Omit<AccessInput, 'event'> {
    return {
      ...(isGuest(access) ? {} : { uid: access.uid }),
      sid: access.sid ?? (sessionPath ? basename(sessionPath) : undefined),
      from,
      via: 'http',
      linkId: access.link?.id,
    };
  }

  /** Record a read of `node` at `path` when it is an original, once per session and file within `DOWNLOAD_REPEAT_MS`. */
  async file(access: Access, sessionPath: NodePath, from: string | undefined, path: NodePath, node: Node, now = Date.now()): Promise<void> {
    if (!isLoggedDownload(path, node)) return;
    const who = this.#who(access, sessionPath, from);

    const key = `${who.sid ?? who.from ?? ''}\0${path}`;
    const last = this.#seen.get(key);
    if (last !== undefined && now - last < DOWNLOAD_REPEAT_MS) return;
    if (this.#seen.size >= SWEEP_AT) {
      for (const [other, at] of this.#seen) if (now - at >= DOWNLOAD_REPEAT_MS) this.#seen.delete(other);
    }
    this.#seen.set(key, now);

    await recordAccess(this.vfs, { event: 'download', ...who, path });
  }

  /** Record a zip of `paths`, by the folder holding them all and how many there are. */
  async archive(access: Access, sessionPath: NodePath, from: string | undefined, paths: NodePath[]): Promise<void> {
    await recordAccess(this.vfs, { event: 'download-archive', ...this.#who(access, sessionPath, from), path: commonFolder(paths), count: paths.length });
  }
}
