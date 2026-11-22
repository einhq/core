/**
 * WebDAV's writes: PUT, MKCOL, MOVE, DELETE and PROPPATCH, each as the signed-in account.
 *
 * An upload is stored as a browser's is (`storeBody`): its type read from its bytes and name, and
 * frozen when `/etc/frozen-uploads` lists the type, so nothing is written over it afterwards, by a
 * PUT or a MOVE onto it. A DELETE moves what it names into the account's trash, where the Web UI's
 * deletes go, and anything inside a trash is read-only here.
 */

import { basename, dirname } from '@std/path';
import { isTrashPath } from '../../../lib/paths.ts';
import { createLogger } from '../../../managers/logger/mod.ts';
import { retypeMovedUpload } from '../../../lib/media/moved-upload.ts';
import { trashPut } from '../../../lib/trash/mod.ts';
import { type Node, NodeAlreadyExistsError, NodeNotFoundError } from '../../../vfs/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../../vfs/types/directory.ts';
import { NODE_TYPE_FILE } from '../../../vfs/types/file.ts';
import { isClientFile } from '../../client-files.ts';
import { storeBody } from '../handlers/store-body.ts';
import type { HttpServerConfig } from '../types.ts';
import { davHref, destination } from './paths.ts';
import { etagOf } from './propfind.ts';
import type { DavUser } from './sign-in.ts';
import { DAV_NS, isElement, MAX_PROPERTIES, MULTISTATUS_CLOSE, MULTISTATUS_OPEN, propElement, type PropName, propstat, type XmlElement, XmlError, xmlEscape } from './xml.ts';

const logger = createLogger('dav');

/** What a write needs: the server's VFS and settings, and who signed in. */
type DavWrite = { config: HttpServerConfig; user: DavUser };

/** A plain-text answer, the body of a request that was not read let go. */
export async function refuse(req: Request, status: number, message: string, headers: HeadersInit = {}): Promise<Response> {
  await req.body?.cancel().catch(() => {});
  return new Response(`${message}\n`, { status, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });
}

/** The node at `path`, a softlink there itself rather than what it points to; undefined when there is none. */
const nodeAt = (ctx: DavWrite, path: string): Promise<Node | undefined> =>
  ctx.config.vfs.get(ctx.user.access, path, { readlink: true }).catch((error) => {
    if (error instanceof NodeNotFoundError) return undefined;
    throw error;
  });

/** Why `parent` cannot hold what a write makes in it, or undefined when it can. */
async function parentRefusal(ctx: DavWrite, parent: string): Promise<string | undefined> {
  const node = await ctx.config.vfs.get(ctx.user.access, parent).catch((error) => {
    if (error instanceof NodeNotFoundError) return undefined;
    throw error;
  });
  if (!node) return `${parent} does not exist`;
  if (isClientFile(node)) return `${parent} is a file`;
  return undefined;
}

/** `X-OC-Mtime`, seconds since the epoch as ownCloud's clients send it, as `writtenAt`; undefined when absent or not a time. */
function ocMtime(headers: Headers): string | undefined {
  const value = headers.get('x-oc-mtime');
  if (value === null || !/^\d+(\.\d+)?$/.test(value.trim())) return undefined;
  const ms = Number(value.trim()) * 1000;
  return Number.isFinite(ms) && ms <= 8.64e15 ? new Date(ms).toISOString() : undefined;
}

/**
 * `body` as it is read, calling `brokeOff` when a read of it fails: the client went away or sent
 * less than it said, which a phone on a weak network does. A failure there is the upload's, not
 * the server's.
 */
function watched(body: ReadableStream<Uint8Array>, brokeOff: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        brokeOff();
        controller.error(error);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/** Whether the ETags an `If-Match` lists hold `etag`; `*` holds any. */
const matches = (header: string, etag: string | undefined): boolean =>
  header.split(',').map((tag) => tag.trim()).some((tag) => tag === '*' ? etag !== undefined : tag === etag);

/**
 * PUT: store the body as the file at `path`, made when it is not there. A body that stops part-way
 * leaves no file behind that this request made.
 */
export async function put(ctx: DavWrite, req: Request, path: string): Promise<Response> {
  const { vfs } = ctx.config;
  const { access } = ctx.user;
  if (req.headers.has('content-range')) return await refuse(req, 400, 'a PUT writes a whole file; Content-Range is not taken');
  if (path === '/') return await refuse(req, 405, 'the root is not a file');
  if (isTrashPath(path)) return await refuse(req, 403, 'the trash is read-only over WebDAV');
  const parent = dirname(path);
  const refusal = await parentRefusal(ctx, parent);
  if (refusal) return await refuse(req, 409, refusal);

  const existing = await vfs.get(access, path).catch((error) => {
    if (error instanceof NodeNotFoundError) return undefined;
    throw error;
  });
  if (existing && !isClientFile(existing)) return await refuse(req, 405, `${path} is a folder`);
  if (existing && existing.type !== NODE_TYPE_FILE) return await refuse(req, 405, `${path} is not a file that can be written`);
  const etag = existing && etagOf(existing.attrs);
  const ifNoneMatch = req.headers.get('if-none-match');
  if (ifNoneMatch !== null && existing && (ifNoneMatch.trim() === '*' || matches(ifNoneMatch, etag))) return await refuse(req, 412, `${path} is there already`);
  const ifMatch = req.headers.get('if-match');
  if (ifMatch !== null && !matches(ifMatch, etag)) return await refuse(req, 412, `${path} is not the version asked for`);
  if (existing?.attrs.frozen === true) return await refuse(req, 403, `${path} is frozen: nothing is written over an upload`);

  let created = false;
  if (!existing) {
    try {
      await vfs.create(access, NODE_TYPE_FILE, parent, basename(path), { attrs: { name: basename(path) } });
      created = true;
    } catch (error) {
      // Another PUT of the same new path made it first; this one writes its bytes.
      if (!(error instanceof NodeAlreadyExistsError)) throw error;
    }
  }

  let attrs;
  let brokeOff = false;
  try {
    attrs = await storeBody(ctx.config, access, path, req.body && watched(req.body, () => brokeOff = true));
  } catch (error) {
    if (created) await vfs.unlink(access, path, parent).catch(() => {});
    if (!brokeOff) throw error;
    logger.info('a WebDAV upload broke off', { path, user: ctx.user.username, error: error instanceof Error ? error.message : String(error) });
    return new Response('the upload broke off before its end\n', { status: 400 });
  }

  const headers = new Headers();
  const writtenAt = ocMtime(req.headers);
  if (writtenAt) {
    await vfs.update(access, path, { attrs: { writtenAt } });
    headers.set('X-OC-MTime', 'accepted');
  }
  const written = etagOf(attrs);
  if (written) headers.set('ETag', written);
  return new Response(null, { status: created ? 201 : 204, headers });
}

/** MKCOL: make the folder `path`. */
export async function mkcol(ctx: DavWrite, req: Request, path: string): Promise<Response> {
  const length = Number(req.headers.get('content-length') ?? '0');
  if (length > 0 || req.headers.has('transfer-encoding')) return await refuse(req, 415, 'MKCOL takes no body');
  if (path === '/') return await refuse(req, 405, 'the root is there already');
  if (isTrashPath(path)) return await refuse(req, 403, 'the trash is read-only over WebDAV');
  if (await nodeAt(ctx, path)) return await refuse(req, 405, `${path} is there already`);
  const refusal = await parentRefusal(ctx, dirname(path));
  if (refusal) return await refuse(req, 409, refusal);
  await ctx.config.vfs.create(ctx.user.access, NODE_TYPE_DIRECTORY, dirname(path), basename(path));
  return new Response(null, { status: 201 });
}

/**
 * MOVE: rename `path` to the `Destination`, with the softlinks to it, as `mv` moves. With
 * `Overwrite: T`, the default, a file there is replaced, unless it is frozen or has nodes of its
 * own (a photo already read); a folder is never replaced. A file moved onto its final name, an
 * upload sent under a temporary one, gets the type, freezing and name an upload under that name gets.
 */
export async function move(ctx: DavWrite, req: Request, url: URL, path: string): Promise<Response> {
  const { vfs } = ctx.config;
  const { access } = ctx.user;
  const to = destination(req.headers.get('destination'), url);
  if ('refused' in to) {
    return await refuse(req, to.refused, to.refused === 502 ? 'the Destination is not in this WebDAV tree' : 'a MOVE needs a Destination in this tree');
  }
  const overwriteHeader = (req.headers.get('overwrite') ?? 'T').trim().toUpperCase();
  if (overwriteHeader !== 'T' && overwriteHeader !== 'F') return await refuse(req, 400, 'Overwrite is T or F');
  const overwrite = overwriteHeader === 'T';
  if (to.path === path) return await refuse(req, 403, 'the source and the Destination are the same');
  if (path === '/' || to.path === '/') return await refuse(req, 403, 'the root does not move');
  if (isTrashPath(path) || isTrashPath(to.path)) return await refuse(req, 403, 'the trash is read-only over WebDAV');
  if (to.path.startsWith(`${path}/`)) return await refuse(req, 409, 'a folder cannot move into itself');

  const source = await nodeAt(ctx, path);
  if (!source) return await refuse(req, 404, `${path} does not exist`);
  const depth = req.headers.get('depth');
  if (depth !== null && depth.trim().toLowerCase() !== 'infinity' && !isClientFile(source)) return await refuse(req, 400, 'a folder moves whole: Depth is infinity');
  const refusal = await parentRefusal(ctx, dirname(to.path));
  if (refusal) return await refuse(req, 409, refusal);

  const existing = await nodeAt(ctx, to.path);
  if (existing) {
    if (!overwrite) return await refuse(req, 412, `${to.path} is there already`);
    if (!isClientFile(existing) && !existing.props.softlink) return await refuse(req, 409, `${to.path} is a folder, which a MOVE does not replace`);
    if (existing.attrs.frozen === true) return await refuse(req, 403, `${to.path} is frozen: nothing is written over an upload`);
    if (await vfs.childCount(access, to.path, { readlink: true, all: true }) > 0) return await refuse(req, 409, `${to.path} has nodes of its own, so it is not replaced`);
  }

  const [outcome] = await vfs.renameMany(access, [{ from: path, to: to.path }], { failIfExists: !overwrite, relink: true });
  if (outcome.status === 'rejected') throw outcome.reason;
  if (outcome.value.already) return await refuse(req, 404, `${path} does not exist`);
  const moved = outcome.value.node;
  await retypeMovedUpload(vfs, access, to.path, moved);
  // A PUT names the file it makes as it was sent (`attrs.name`, what the pages show); one moved
  // off that name is called by its new one, and a name someone gave it is left alone.
  if (moved.attrs.name === basename(path) && basename(to.path) !== basename(path)) {
    await vfs.update(access, to.path, { attrs: { name: basename(to.path) } });
  }
  return new Response(null, { status: existing ? 204 : 201 });
}

/** DELETE: move `path` into the account's trash, a softlink as itself, a folder with all it holds. */
export async function remove(ctx: DavWrite, req: Request, path: string): Promise<Response> {
  if (path === '/') return await refuse(req, 403, 'the root is not deleted');
  if (isTrashPath(path)) return await refuse(req, 403, 'the trash is read-only over WebDAV');
  if (!await nodeAt(ctx, path)) return await refuse(req, 404, `${path} does not exist`);
  await trashPut(ctx.config.vfs, ctx.user.access, ctx.user.home, [path]);
  return new Response(null, { status: 204 });
}

/** The properties a PROPPATCH may set: a file's modification time, as WebDAV and Windows name it. */
const SETTABLE: PropName[] = [{ ns: DAV_NS, name: 'getlastmodified' }, { ns: 'urn:schemas-microsoft-com:', name: 'Win32LastModifiedTime' }];

const settable = (prop: PropName): boolean => SETTABLE.some((known) => known.ns === prop.ns && known.name === prop.name);

type PropChange = { prop: PropName; remove: boolean; value: string };

/**
 * The changes a PROPPATCH body asks for, in order.
 * @throws XmlError when the document is not a propertyupdate
 */
function propChanges(body: XmlElement): PropChange[] {
  if (!isElement(body, DAV_NS, 'propertyupdate')) throw new XmlError('not a propertyupdate');
  const changes: PropChange[] = [];
  for (const instruction of body.children) {
    const remove = isElement(instruction, DAV_NS, 'remove');
    if (!remove && !isElement(instruction, DAV_NS, 'set')) continue;
    for (const holder of instruction.children) {
      if (!isElement(holder, DAV_NS, 'prop')) continue;
      for (const prop of holder.children) {
        if (changes.length >= MAX_PROPERTIES) throw new XmlError(`more than ${MAX_PROPERTIES} properties to change`);
        changes.push({ prop: { ns: prop.ns, name: prop.name }, remove, value: prop.text.trim() });
      }
    }
  }
  if (changes.length === 0) throw new XmlError('a propertyupdate that changes nothing');
  return changes;
}

/**
 * PROPPATCH: set a file's modification time, all or nothing. Every other property, and removing
 * one, is refused (403), and then the rest fail with it (424); nothing is stored for a client.
 */
export async function proppatch(ctx: DavWrite, path: string, body: XmlElement): Promise<Response> {
  const { vfs } = ctx.config;
  const node = await vfs.get(ctx.user.access, path);
  if (isTrashPath(path)) return new Response('the trash is read-only over WebDAV\n', { status: 403 });
  const changes = propChanges(body);

  const refused = new Set<number>();
  const conflicts = new Set<number>();
  let writtenAt: string | undefined;
  changes.forEach((change, i) => {
    if (change.remove || !settable(change.prop) || node.type !== NODE_TYPE_FILE) {
      refused.add(i);
      return;
    }
    const time = Date.parse(change.value);
    if (Number.isNaN(time)) conflicts.add(i);
    else writtenAt = new Date(time).toISOString();
  });

  const failed = refused.size > 0 || conflicts.size > 0;
  if (!failed && writtenAt) await vfs.update(ctx.user.access, path, { attrs: { writtenAt } });

  const groups = new Map<string, string[]>();
  changes.forEach((change, i) => {
    const status = refused.has(i) ? '403 Forbidden' : conflicts.has(i) ? '409 Conflict' : failed ? '424 Failed Dependency' : '200 OK';
    const group = groups.get(status) ?? [];
    group.push(propElement(change.prop));
    groups.set(status, group);
  });
  const propstats = [...groups].map(([status, props]) => {
    const [code, ...reason] = status.split(' ');
    return propstat(props, Number(code), reason.join(' '));
  }).join('');
  const href = xmlEscape(davHref(path, !isClientFile(node)));
  const xml = `${MULTISTATUS_OPEN}<D:response><D:href>${href}</D:href>${propstats}</D:response>${MULTISTATUS_CLOSE}`;
  return new Response(xml, { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}
