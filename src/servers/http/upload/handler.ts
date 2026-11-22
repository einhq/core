/**
 * Uploads in pieces that resume, at `/upload/`: the tus protocol 1.0 (<https://tus.io>), its core
 * and the creation, expiration and termination extensions, as the signed-in account: the session's,
 * or the account a phone was paired as when the request carries the EiN app's token
 * (`Authorization: Bearer`, `device-app`).
 *
 * `POST /upload/` begins an upload of `Upload-Length` bytes and answers where it is
 * (`Location: /upload/<id>`); each `PATCH` there appends a piece at `Upload-Offset`; a `HEAD` says how
 * much has arrived, so a sender whose connection broke goes on from there; a `DELETE` gives it up.
 * `Upload-Metadata` names the folder (`dir`) and the file's name (`filename`), and may give the
 * file's own time (`mtime`, seconds since the epoch). The pieces collect in the spool (`spool.ts`);
 * the one that completes the upload stores it as `POST /file` would, under a numbered name when
 * the name is taken, and its answer, as every later `HEAD`'s, names the file in `Content-Location`.
 */

import { decodeBase64 } from '@std/encoding';
import { normalize } from '@std/path';
import { Access, isGuest, verifyAccess } from '../../../lib/access/mod.ts';
import { createLogger } from '../../../managers/logger/mod.ts';
import { NodeAccessDeniedError, NodeFrozenError, NodeNotFoundError } from '../../../vfs/mod.ts';
import { isClientFile } from '../../client-files.ts';
import { appOrSessionAccess } from '../app-access.ts';
import { HttpServerConfig } from '../types.ts';
import {
  appendPiece,
  createUpload,
  findUpload,
  removeUpload,
  spooledBytes,
  type SpooledUpload,
  spoolLimits,
  storeUpload,
  UploadNotStoredError,
  type UploadPlan,
} from './spool.ts';

const logger = createLogger('upload');

const TUS_VERSION = '1.0.0';

/** The path uploads are begun at, and under which each one is. */
const UPLOAD_PATH = '/upload';

/** Whether `pathname` is an upload's, or where they begin. */
export const isUploadPath = (pathname: string): boolean => pathname === UPLOAD_PATH || pathname.startsWith(`${UPLOAD_PATH}/`);

/** `Upload-Metadata` gives at most this much. */
const MAX_METADATA = 4096;

type Answer = { status: number; message?: string; headers?: Record<string, string> };

/** `Upload-Metadata`, its keys with their values decoded; undefined when it is not well formed. */
function parseMetadata(header: string): Map<string, string> | undefined {
  const pairs = new Map<string, string>();
  if (header.trim() === '') return pairs;
  for (const pair of header.split(',')) {
    const [key, value, ...rest] = pair.trim().split(' ');
    if (!key || rest.length > 0 || pairs.has(key)) return undefined;
    try {
      pairs.set(key, value === undefined ? '' : new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(value)));
    } catch {
      return undefined;
    }
  }
  return pairs;
}

/** A header's value as a whole number of bytes, or undefined when it is not one. */
function byteCount(value: string | null): number | undefined {
  if (value === null || !/^\d{1,16}$/.test(value.trim())) return undefined;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) ? n : undefined;
}

/** `mtime` in seconds since the epoch as a `writtenAt`; undefined when it is not a time. */
function mtimeOf(value: string | undefined): string | undefined {
  if (value === undefined || !/^\d+(\.\d+)?$/.test(value.trim())) return undefined;
  const ms = Number(value.trim()) * 1000;
  return Number.isFinite(ms) && ms <= 8.64e15 ? new Date(ms).toISOString() : undefined;
}

const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

/** What every answer about `upload` says of it. */
function uploadHeaders(upload: SpooledUpload): Record<string, string> {
  const headers: Record<string, string> = {
    'Upload-Offset': String(upload.offset),
    'Upload-Length': String(upload.length),
    'Upload-Expires': new Date(upload.expiresAt).toUTCString(),
  };
  if (upload.stored !== undefined) headers['Content-Location'] = `/file${encodePath(upload.stored)}`;
  return headers;
}

/** The answer to a store that failed, with the status its error calls for. */
function notStored(error: unknown): Answer {
  if (error instanceof UploadNotStoredError) return { status: error.status, message: error.message };
  if (error instanceof NodeAccessDeniedError || error instanceof NodeFrozenError) return { status: 403, message: 'the folder may not be written' };
  if (error instanceof NodeNotFoundError) return { status: 409, message: 'the folder is gone' };
  throw error;
}

/**
 * The uploads of one server: who is sending which upload's piece now. Per server rather than
 * module-level, as the WebDAV sign-ins are: the test harness starts several in one process.
 */
export class Uploads {
  /** The request writing each upload, by uid and id, and how to stop it. */
  readonly #busy = new Map<string, { stop: AbortController; done: Promise<void> }>();

  constructor(private readonly config: HttpServerConfig) {}

  async handle(req: Request, url: URL, from: string | undefined): Promise<Response> {
    if (req.method === 'OPTIONS') {
      const { maxBytes } = await spoolLimits(this.config.vfs);
      return await this.#answer(req, { status: 204, headers: { 'Tus-Max-Size': String(maxBytes) } });
    }
    if (req.headers.get('tus-resumable') !== TUS_VERSION) {
      return await this.#answer(req, { status: 412, message: `this server speaks tus ${TUS_VERSION}` });
    }
    const access = await appOrSessionAccess(this.config, req, from, 'an upload');
    if (!access || isGuest(access)) return await this.#answer(req, { status: 401, message: 'sign in to upload' });

    const rest = url.pathname.slice(UPLOAD_PATH.length).replace(/^\/+|\/+$/g, '');
    if (rest === '') {
      if (req.method === 'POST') return await this.#answer(req, await this.#create(req, access));
      return await this.#answer(req, { status: 405, message: 'an upload begins with a POST' });
    }
    if (rest.includes('/')) return await this.#answer(req, { status: 404, message: 'no such upload' });

    switch (req.method) {
      case 'HEAD':
        return await this.#answer(req, await this.#locked(access, rest, (upload) => this.#state(access, upload)));
      case 'PATCH':
        return await this.#answer(req, await this.#patch(req, access, rest));
      case 'DELETE':
        return await this.#answer(
          req,
          await this.#locked(access, rest, async (upload) => {
            await removeUpload(this.config.vfs, access.uid, upload);
            return { status: 204 };
          }),
        );
      default:
        return await this.#answer(req, { status: 405, message: 'an upload takes HEAD, PATCH and DELETE' });
    }
  }

  async #answer(req: Request, answer: Answer): Promise<Response> {
    await req.body?.cancel().catch(() => {});
    const headers = new Headers({ 'Tus-Resumable': TUS_VERSION, 'Cache-Control': 'no-store', ...answer.headers });
    if (req.method === 'OPTIONS' || answer.status === 412) {
      headers.set('Tus-Version', TUS_VERSION);
      headers.set('Tus-Extension', 'creation,expiration,termination');
    }
    if (answer.message === undefined || req.method === 'HEAD') return new Response(null, { status: answer.status, headers });
    headers.set('Content-Type', 'text/plain; charset=utf-8');
    return new Response(`${answer.message}\n`, { status: answer.status, headers });
  }

  /** POST: begin an upload, or store an empty one at once. */
  async #create(req: Request, access: Access): Promise<Answer> {
    const { vfs } = this.config;
    if (req.headers.has('upload-defer-length')) return { status: 400, message: 'an upload says its length when it begins' };
    const length = byteCount(req.headers.get('upload-length'));
    if (length === undefined) return { status: 400, message: 'Upload-Length is required' };

    const metadata = req.headers.get('upload-metadata') ?? '';
    const pairs = metadata.length <= MAX_METADATA ? parseMetadata(metadata) : undefined;
    if (!pairs) return { status: 400, message: 'Upload-Metadata is not key-value pairs in base64' };
    const name = pairs.get('filename') ?? '';
    if (name === '' || name === '.' || name === '..' || name.includes('/')) return { status: 400, message: 'a filename without a slash is required' };
    const dirMeta = pairs.get('dir') ?? '';
    if (!dirMeta.startsWith('/')) return { status: 400, message: 'a dir from the root is required' };
    const dir = normalize(dirMeta).replace(/(.)\/+$/, '$1');

    const folder = await vfs.get(access, dir).catch((error) => {
      if (error instanceof NodeNotFoundError) return undefined;
      throw error;
    });
    if (!folder) return { status: 404, message: `${dir} does not exist` };
    if (isClientFile(folder)) return { status: 409, message: `${dir} is a file` };
    if (!verifyAccess(access, folder.props, 'w')) return { status: 403, message: `${dir} may not be written` };

    const { maxBytes, expiresMs } = await spoolLimits(vfs);
    if (length > maxBytes) return { status: 413, message: `an upload is at most ${maxBytes} bytes` };
    if (await spooledBytes(vfs, access.uid, expiresMs) + length > maxBytes) {
      return { status: 413, message: `the uploads begun and not finished would be more than ${maxBytes} bytes` };
    }

    const plan: UploadPlan = { dir, name, length, metadata };
    const writtenAt = mtimeOf(pairs.get('mtime'));
    if (writtenAt) plan.writtenAt = writtenAt;
    let upload = await createUpload(vfs, access.uid, plan, expiresMs);
    if (length === 0) {
      const finished = await this.#finish(access, upload);
      if ('status' in finished) return finished;
      upload = finished;
    }
    return { status: 201, headers: { ...uploadHeaders(upload), Location: `${UPLOAD_PATH}/${upload.id}` } };
  }

  /** HEAD: how much of `upload` has arrived, storing it first if all of it has. */
  async #state(access: Access, upload: SpooledUpload): Promise<Answer> {
    if (upload.stored === undefined && upload.offset === upload.length) {
      const finished = await this.#finish(access, upload);
      if ('status' in finished) return finished;
      upload = finished;
    }
    return { status: 200, headers: { ...uploadHeaders(upload), 'Upload-Metadata': upload.metadata } };
  }

  /** PATCH: append a piece, and store the upload once its last byte is in. */
  async #patch(req: Request, access: Access, id: string): Promise<Answer> {
    if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/offset+octet-stream') {
      return { status: 415, message: 'a piece is sent as application/offset+octet-stream' };
    }
    const offset = byteCount(req.headers.get('upload-offset'));
    if (offset === undefined) return { status: 400, message: 'Upload-Offset is required' };

    return await this.#locked(access, id, async (upload, stop) => {
      if (offset !== upload.offset) return { status: 409, message: `the upload is at ${upload.offset}, not ${offset}`, headers: uploadHeaders(upload) };
      if (upload.stored !== undefined) return { status: 204, headers: uploadHeaders(upload) };
      const declared = byteCount(req.headers.get('content-length'));
      if (declared !== undefined && offset + declared > upload.length) return { status: 413, message: 'the piece runs past Upload-Length' };

      const { offset: arrived, end } = await appendPiece(this.config.vfs, upload, req.body, stop);
      upload = { ...upload, offset: arrived };
      if (end === 'broke-off' || end === 'interrupted') {
        logger.info('an upload piece broke off', { id, uid: access.uid, arrived, length: upload.length, end });
        return { status: end === 'interrupted' ? 409 : 400, message: 'the piece broke off before its end', headers: uploadHeaders(upload) };
      }
      if (arrived === upload.length) {
        const finished = await this.#finish(access, upload);
        if ('status' in finished) return finished;
        upload = finished;
      }
      if (end === 'too-long') return { status: 413, message: 'the piece runs past Upload-Length', headers: uploadHeaders(upload) };
      return { status: 204, headers: uploadHeaders(upload) };
    });
  }

  /** Store `upload`; one that cannot be is removed, and the answer says why. */
  async #finish(access: Access, upload: SpooledUpload): Promise<SpooledUpload | Answer> {
    try {
      return { ...upload, stored: await storeUpload(this.config, access, upload) };
    } catch (error) {
      await removeUpload(this.config.vfs, access.uid, upload);
      logger.warn('an upload that arrived whole was not stored', {
        id: upload.id,
        uid: access.uid,
        dir: upload.dir,
        error: error instanceof Error ? error.message : String(error),
      });
      return notStored(error);
    }
  }

  /**
   * Run `work` on the upload `id` of `access`'s account as the only request at it, or answer 404
   * when there is none. A request already writing it is stopped first: a sender asks again only
   * once it has given up on the connection that request reads, which may not have noticed yet.
   */
  async #locked(access: Access, id: string, work: (upload: SpooledUpload, stop: AbortSignal) => Promise<Answer>): Promise<Answer> {
    const key = `${access.uid}/${id}`;
    for (let other = this.#busy.get(key); other; other = this.#busy.get(key)) {
      other.stop.abort();
      await other.done;
    }
    const stop = new AbortController();
    let release!: () => void;
    this.#busy.set(key, { stop, done: new Promise((resolve) => release = resolve) });
    try {
      const { expiresMs } = await spoolLimits(this.config.vfs);
      const upload = await findUpload(this.config.vfs, access.uid, id, expiresMs);
      if (!upload) return { status: 404, message: 'no such upload' };
      return await work(upload, stop.signal);
    } finally {
      this.#busy.delete(key);
      release();
    }
  }
}
