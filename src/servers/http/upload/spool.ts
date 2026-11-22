/**
 * The upload spool: an upload sent in pieces collects in a file of its own,
 * `/var/spool/uploads/<uid>/<id>`, which only the administrator reads, until its last byte has
 * arrived. Then it is written into its folder in one write, as its sender, the way a `POST /file`
 * stores a file, and the spool file keeps only where it went.
 *
 * What the upload is for rides on the spool file as `attrs.upload`; how much has arrived is the
 * file's size. A spool file unchanged for `CFG_UPLOAD_EXPIRES_HOURS` is gone as far as this module
 * answers, and the upload-reaper service removes it.
 */

import { basename, dirname, join } from '@std/path';
import { ulid } from '@std/ulid';
import { Access, ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { positiveSetting, readSystemSettings } from '../../../lib/config/mod.ts';
import { UPLOAD_SPOOL_PATH, VAR_PATH } from '../../../lib/paths.ts';
import { Node, NodeAlreadyExistsError, NodeNotFoundError, NodeVFS } from '../../../vfs/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../../vfs/types/directory.ts';
import { NODE_TYPE_FILE } from '../../../vfs/types/file.ts';
import { createFreeName } from '../free-name.ts';
import { fileBody } from '../handlers/file-body.ts';
import { storeBody } from '../handlers/store-body.ts';
import { HttpServerConfig } from '../types.ts';

/** What an upload is for, as its spool file's `attrs.upload` holds it. */
export type UploadPlan = {
  /** The folder it goes into. */
  dir: string;
  /** The name asked for; a taken one is numbered, as `POST /file` numbers it. */
  name: string;
  /** Its whole size in bytes. */
  length: number;
  /** `Upload-Metadata` as it was sent, to be given back. */
  metadata: string;
  /** The file's own time, set as its `writtenAt` once it is stored. */
  writtenAt?: string;
  /** Where it was stored, once its last byte arrived. */
  stored?: string;
};

/** An upload in the spool. */
export type SpooledUpload = UploadPlan & {
  id: string;
  /** The spool file. */
  path: string;
  /** Bytes arrived: the whole length once stored. */
  offset: number;
  /** When it is gone unless another piece arrives, in ms since the epoch. */
  expiresAt: number;
};

/** An upload's id, as `create` makes it: a ULID. */
const UPLOAD_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const GB = 1024 ** 3;

/** The spool limits as the system's settings hold them now. */
export async function spoolLimits(vfs: NodeVFS): Promise<{ maxBytes: number; expiresMs: number }> {
  const settings = await readSystemSettings(vfs);
  return {
    maxBytes: Math.floor(positiveSetting(settings, 'CFG_UPLOAD_SPOOL_GB') * GB),
    expiresMs: positiveSetting(settings, 'CFG_UPLOAD_EXPIRES_HOURS') * 3600_000,
  };
}

const spoolDir = (uid: number): string => join(UPLOAD_SPOOL_PATH, String(uid));

const getIfPresent = (vfs: NodeVFS, path: string): Promise<Node | undefined> =>
  vfs.get(ADMIN_ACCESS, path).catch((error) => {
    if (error instanceof NodeNotFoundError) return undefined;
    throw error;
  });

/** `node` as an upload, or undefined when it holds none. */
function spooled(node: Node, id: string, path: string, expiresMs: number): SpooledUpload | undefined {
  const plan = node.attrs.upload as UploadPlan | undefined;
  if (!plan || typeof plan.length !== 'number') return undefined;
  return {
    ...plan,
    id,
    path,
    offset: plan.stored !== undefined ? plan.length : Number(node.attrs.size ?? 0),
    expiresAt: node.props.modtime.timestamp + expiresMs,
  };
}

/** The upload `id` of the account `uid`, or undefined when it has none by that id or it expired. */
export async function findUpload(vfs: NodeVFS, uid: number, id: string, expiresMs: number): Promise<SpooledUpload | undefined> {
  if (!UPLOAD_ID.test(id)) return undefined;
  const path = join(spoolDir(uid), id);
  const node = await getIfPresent(vfs, path);
  const upload = node && spooled(node, id, path, expiresMs);
  return upload && upload.expiresAt > Date.now() ? upload : undefined;
}

/** The bytes the account `uid`'s unfinished uploads will take when whole. */
export async function spooledBytes(vfs: NodeVFS, uid: number, expiresMs: number): Promise<number> {
  if (!await getIfPresent(vfs, spoolDir(uid))) return 0;
  const now = Date.now();
  let bytes = 0;
  for (const child of await vfs.children(ADMIN_ACCESS, spoolDir(uid))) {
    const upload = spooled(child.node, child.name, join(spoolDir(uid), child.name), expiresMs);
    if (upload && upload.stored === undefined && upload.expiresAt > now) bytes += upload.length;
  }
  return bytes;
}

/** Make the spool folder `path`, and those above it that boot has not made, only the administrator's. */
async function makeDir(vfs: NodeVFS, path: string): Promise<void> {
  if (path === VAR_PATH || await getIfPresent(vfs, path)) return;
  await makeDir(vfs, dirname(path));
  await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, dirname(path), basename(path), { props: { mode: 0o700 } }).catch((error) => {
    if (!(error instanceof NodeAlreadyExistsError)) throw error;
  });
}

/** A new, empty upload of the account `uid`. */
export async function createUpload(vfs: NodeVFS, uid: number, plan: UploadPlan, expiresMs: number): Promise<SpooledUpload> {
  await makeDir(vfs, spoolDir(uid));
  const id = ulid();
  const node = await vfs.create(ADMIN_ACCESS, NODE_TYPE_FILE, spoolDir(uid), id, { props: { mode: 0o600 }, attrs: { name: id, upload: plan } });
  return spooled(node, id, join(spoolDir(uid), id), expiresMs)!;
}

/** How a piece's body went: read to its end, read to the upload's end with more behind it, or cut off. */
type PieceEnd = 'whole' | 'too-long' | 'broke-off' | 'interrupted';

/**
 * Append `body` to `upload`'s spool file, as far as its length; what arrived before the body broke
 * off or `signal` interrupted it is kept, so the upload resumes from there.
 * @returns the bytes now arrived, and how the body ended
 */
export async function appendPiece(
  vfs: NodeVFS,
  upload: SpooledUpload,
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
): Promise<{ offset: number; end: PieceEnd }> {
  let end: PieceEnd = 'whole';
  if (body) {
    const handle = await vfs.open(ADMIN_ACCESS, upload.path, { mode: 'a' });
    const reader = body.getReader();
    const interrupt = () => {
      end = 'interrupted';
      reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', interrupt, { once: true });
    let left = upload.length - upload.offset;
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          if (end === 'whole') end = 'broke-off';
          break;
        }
        if (chunk.done) break;
        const piece = chunk.value.length > left ? chunk.value.subarray(0, left) : chunk.value;
        if (piece.length > 0) await handle.write(piece);
        left -= piece.length;
        if (piece.length < chunk.value.length) {
          end = 'too-long';
          await reader.cancel().catch(() => {});
          break;
        }
      }
    } finally {
      signal.removeEventListener('abort', interrupt);
      await handle.close();
    }
  }
  const node = await vfs.get(ADMIN_ACCESS, upload.path);
  return { offset: Number(node.attrs.size ?? 0), end };
}

/** Why an upload that arrived whole could not be stored, and the status that says so. */
export class UploadNotStoredError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Store `upload`, all of whose bytes have arrived, in its folder as `access`, under its name or
 * the first free numbered one, in one write that reads its type and sha256 as it goes; then let
 * the spool file go of its bytes and keep where it went.
 * @returns the path it was stored at
 * @throws UploadNotStoredError when every name is taken
 */
export async function storeUpload(config: HttpServerConfig, access: Access, upload: SpooledUpload): Promise<string> {
  const { vfs } = config;
  const name = await createFreeName(config, access, upload.dir, upload.name);
  if (name === undefined) throw new UploadNotStoredError(409, `no free name for ${upload.name} in ${upload.dir}`);
  const path = join(upload.dir, name);

  const handle = await vfs.open(ADMIN_ACCESS, upload.path, { mode: 'r' });
  try {
    await storeBody(config, access, path, fileBody(handle, upload.length, new AbortController().signal));
  } catch (error) {
    await handle.close().catch(() => {});
    await vfs.unlink(access, path, upload.dir).catch(() => {});
    throw error;
  }
  if (upload.writtenAt) await vfs.update(access, path, { attrs: { writtenAt: upload.writtenAt } });

  const plan: UploadPlan = { dir: upload.dir, name: upload.name, length: upload.length, metadata: upload.metadata, stored: path };
  if (upload.writtenAt) plan.writtenAt = upload.writtenAt;
  await vfs.update(ADMIN_ACCESS, upload.path, { attrs: { upload: plan } });
  await (await vfs.open(ADMIN_ACCESS, upload.path, { mode: 'w' })).close();
  return path;
}

/** Remove `upload` from the spool; a file it was stored as stays. */
export async function removeUpload(vfs: NodeVFS, uid: number, upload: SpooledUpload): Promise<void> {
  await vfs.unlink(ADMIN_ACCESS, upload.path, spoolDir(uid)).catch((error) => {
    if (!(error instanceof NodeNotFoundError)) throw error;
  });
}
