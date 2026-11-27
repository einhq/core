/**
 * A node held open over a WebSocket, binary both ways:
 *
 *   GET /file/<stream>?mode=w   (Upgrade: websocket)  the socket is the stream's writer while it is
 *                               open: each binary message one write; its close ends the stream
 *   GET /file/<stream>?mode=r   (Upgrade: websocket)  each chunk the reader is given, one binary
 *                               message; the stream's end closes the socket
 *   GET /file/<socket>?mode=rw  (Upgrade: websocket)  a connection to the socket's listener while it
 *                               is open: each binary message one message to it, each message from it
 *                               one binary message; the connection's end closes the socket
 *
 * A `stream` node opens read or written, never both; a `socket` node only as a connection, for
 * two-way traffic. The socket acts as the session its cookie names, as a file ticket's access
 * (`?ticket=`, which only reads), or as an invitation (`?invite=`), which opens only its own nodes in
 * their modes, with its creator's access, and closes its sockets when it expires or is turned off. With a ticket or an
 * invitation the cookie is not read. Whether the access may is the node's ordinary read or write check.
 *
 * What is refused before the socket opens is said in its close frame, which a page can read, as
 * 4000 + the HTTP status the same refusal would get (`NODE_SOCKET_CLOSE`).
 */

import { isVisitor } from '../../../lib/access/mod.ts';
import { NODE_SOCKET_CLOSE } from '../../../lib/api/node-socket.ts';
import type { Access } from '../../../lib/access/types.ts';
import { holdInvitationSocket, invitationByToken, invitationOpens, markInvitationOpened } from '../../../lib/invitations/mod.ts';
import { createLogger } from '../../../managers/logger/mod.ts';
import { isStreamReader, STREAM_READER_BUFFER } from '../../../registries/stream/types.ts';
import type { ResourceHandleIf } from '../../../registries/types.ts';
import { NodeAccessDeniedError, NodeFrozenError, NodeNotFoundError, NodeReadonlyError } from '../../../vfs/mod.ts';
import { isSocketConnection } from '../../../registries/socket/types.ts';
import { NODE_TYPE_SOCKET } from '../../../vfs/types/socket.ts';
import { NODE_TYPE_STREAM } from '../../../vfs/types/stream.ts';
import { getSession, refusesGuest } from '../session.ts';
import type { HttpServerConfig } from '../types.ts';
import type { OpenSockets } from '../ws/open-sockets.ts';

const logger = createLogger('http-file-socket');

/** How much a reader's socket may have unsent before the next chunk waits: past it, the stream's queue fills instead. */
const SOCKET_HIGH_WATER = 1024 * 1024;

type Mode = 'r' | 'w' | 'rw';
type Refusal = { code: number; reason: string };
/** Whom a socket acts as: its access, whether it counts as a visitor's, and the invitation it opened with. */
type Grant = { access: Access; visitor: boolean; invitation?: { id: string; expiresAt: number; nodes: Set<string> } };
type SocketConfig = HttpServerConfig & { sockets: OpenSockets };

/** Whether `req` asks to become a WebSocket. */
export const isWebSocketUpgrade = (req: Request): boolean => req.headers.get('upgrade')?.toLowerCase() === 'websocket';

const refusal = (code: number, reason: string): Refusal => ({ code, reason });

/** What a mode does to a node, for a refusal's reason. */
const verb = (mode: Mode): string => mode === 'r' ? 'read' : mode === 'w' ? 'write' : 'connect';

/** A failure to open a node, as its socket's close frame says it. */
function openRefusal(error: unknown, path: string): Refusal | undefined {
  if (error instanceof NodeNotFoundError) return refusal(NODE_SOCKET_CLOSE.notFound, `no node at ${path}`);
  if (error instanceof NodeAccessDeniedError) return refusal(NODE_SOCKET_CLOSE.forbidden, `no access to ${path}`);
  if (error instanceof NodeFrozenError || error instanceof NodeReadonlyError) return refusal(NODE_SOCKET_CLOSE.forbidden, `${path} cannot be written`);
  if (error instanceof Error && error.message === 'the stream has a writer already') return refusal(NODE_SOCKET_CLOSE.conflict, `${path} has a writer already`);
  if (error instanceof Error && error.message === 'nobody listens on the socket') return refusal(NODE_SOCKET_CLOSE.unavailable, `nobody listens on ${path}`);
  if (error instanceof Error && error.message === 'the socket has too many connections waiting') {
    return refusal(NODE_SOCKET_CLOSE.unavailable, `${path} has too many connections waiting`);
  }
  return undefined;
}

/** Whom a socket acts as, or why it may not open: an invitation, a ticket as `GET /file` takes one, or the session. */
async function socketAccess(config: SocketConfig, req: Request, url: URL, path: string, mode: Mode): Promise<Grant | Refusal> {
  const invite = url.searchParams.get('invite');
  if (invite !== null) {
    const found = await invitationByToken(config.vfs, invite);
    if (!found) return refusal(NODE_SOCKET_CLOSE.forbidden, 'this invitation does not open anything any more');
    // Asked before anything is looked up by the path, so a holder learns nothing of what else its creator reaches.
    if (!await invitationOpens(config.vfs, found.node.attrs, path, mode)) return refusal(NODE_SOCKET_CLOSE.forbidden, `the invitation does not open ${path} to ${verb(mode)}`);
    const nodes = new Set(found.node.attrs.nodes.filter((node) => node.mode === mode).map((node) => node.id));
    return { access: found.access, visitor: true, invitation: { id: found.id, expiresAt: found.node.attrs.expiresAt, nodes } };
  }
  const ticket = url.searchParams.get('ticket');
  if (ticket !== null) {
    if (mode !== 'r') return refusal(NODE_SOCKET_CLOSE.forbidden, 'a ticket reads a node; it does not write one');
    const access = config.devices?.fileTicketAccess(ticket, path);
    return access ? { access, visitor: isVisitor(access) } : refusal(NODE_SOCKET_CLOSE.forbidden, 'the ticket has run out or is for another file');
  }
  const { access } = await getSession(config, req.headers, { create: false, refresh: false });
  if (await refusesGuest(config, access)) return refusal(NODE_SOCKET_CLOSE.signIn, 'sign in first');
  return { access, visitor: isVisitor(access) };
}

/** Open the node at `path` as `access`, or say why not; with `only`, only a node of those ids. */
async function openNode(config: SocketConfig, access: Access, path: string, mode: Mode, only?: Set<string>): Promise<ResourceHandleIf | Refusal> {
  try {
    const entry = await config.vfs.resolvePath(access, path);
    const node = await config.vfs.get(access, entry);
    // Another node put at the path since the invitation was asked about it.
    if (only && !only.has(node.id)) return refusal(NODE_SOCKET_CLOSE.forbidden, `the invitation does not open ${path} to ${verb(mode)}`);
    if (node.type === NODE_TYPE_SOCKET) {
      if (mode !== 'rw') return refusal(NODE_SOCKET_CLOSE.badRequest, `a socket node is connected to, with mode=rw; ${path} is one`);
      return await config.vfs.open(access, entry, { mode: 'r+' });
    }
    if (node.type !== NODE_TYPE_STREAM) return refusal(NODE_SOCKET_CLOSE.badRequest, `a socket opens a stream or a socket node; ${path} is a ${node.type}`);
    if (mode === 'rw') return refusal(NODE_SOCKET_CLOSE.badRequest, 'a stream is read or written, not both: open one socket for each, or use a socket node');
    return await config.vfs.open(access, entry, { mode });
  } catch (error) {
    const refused = openRefusal(error, path);
    if (refused) return refused;
    throw error;
  }
}

/** Close `socket` with `code` and `reason` once it is open, or now when it is. */
function closeSocket(socket: WebSocket, code: number, reason: string): void {
  const close = () => {
    try {
      socket.close(code, reason);
    } catch { /* closing already */ }
  };
  if (socket.readyState === WebSocket.CONNECTING) socket.addEventListener('open', close, { once: true });
  else if (socket.readyState === WebSocket.OPEN) close();
}

/**
 * Answer a WebSocket upgrade on `/file/<path>`: the socket, which then reads or writes the node, or
 * closes at once with why it may not. Only a visitor over its share of sockets is refused before
 * the upgrade, with 429, as a shell's socket is.
 */
export async function handleFileSocket(config: SocketConfig, req: Request, url: URL, from: string | undefined): Promise<Response> {
  const path = decodeURIComponent(url.pathname.replace('/file', ''));
  const asked = url.searchParams.get('mode');
  const mode = asked === 'r' || asked === 'w' || asked === 'rw' ? asked : undefined;

  let opened: ResourceHandleIf | Refusal;
  let visitor: string | undefined;
  let invitation: Grant['invitation'];
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) {
    opened = refusal(NODE_SOCKET_CLOSE.notFound, `no node at ${path}`);
  } else if (!mode) {
    opened = refusal(NODE_SOCKET_CLOSE.badRequest, 'say how the node is opened: mode=r, mode=w or mode=rw');
  } else {
    const grant = await socketAccess(config, req, url, path, mode);
    if ('code' in grant) {
      opened = grant;
    } else {
      if (grant.visitor) {
        visitor = from ?? '';
        if (!config.sockets.admitsVisitor(visitor)) {
          logger.warn('refused a visitor socket over the limit', { from });
          return new Response('too many connections', { status: 429, headers: { 'Retry-After': '60' } });
        }
      }
      opened = await openNode(config, grant.access, path, mode, grant.invitation?.nodes);
      invitation = grant.invitation;
    }
  }

  const { socket, response } = config.sockets.upgrade(req, visitor);
  socket.binaryType = 'arraybuffer';
  if ('code' in opened) {
    closeSocket(socket, opened.code, opened.reason);
    return response;
  }

  const handle = opened;
  if (invitation) {
    logger.info('an invitation opened a node', { invitation: invitation.id, path, mode, from });
    endWithInvitation(socket, invitation);
    // Held first: one turned off since it was looked up is closed here, or by its removal.
    if (!await markInvitationOpened(config.vfs, invitation.id)) closeSocket(socket, NODE_SOCKET_CLOSE.gone, 'the invitation was turned off');
  } else {
    logger.debug('a socket opened a node', { path, mode, from });
  }
  if (mode === 'w') writeFromSocket(socket, handle, path);
  else if (mode === 'r') readIntoSocket(socket, handle, path);
  else connectSocket(socket, handle, path);
  return response;
}

/** The longest a timer waits at once: a longer delay fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Close `socket` with 4410 when its invitation expires or is turned off, unless it closes first. */
function endWithInvitation(socket: WebSocket, invitation: NonNullable<Grant['invitation']>): void {
  const end = (reason: string) => closeSocket(socket, NODE_SOCKET_CLOSE.gone, reason);
  const release = holdInvitationSocket(invitation.id, end);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    const left = invitation.expiresAt - Date.now();
    if (left <= 0) return end('the invitation has expired');
    timer = setTimeout(arm, Math.min(left, MAX_TIMER_MS));
  };
  arm();
  socket.addEventListener('close', () => {
    clearTimeout(timer);
    release();
  }, { once: true });
}

/**
 * Each binary message the socket receives, one write of `handle`'s, while `closing` says no; one
 * that is not binary or is too large closes the socket, and so does a write that fails, with `failed`.
 */
function writeMessages(
  socket: WebSocket,
  handle: ResourceHandleIf,
  path: string,
  closing: () => boolean,
  close: (code: number, reason: string) => void,
  failed: Refusal,
): void {
  socket.addEventListener('message', (event) => {
    if (closing()) return;
    if (!(event.data instanceof ArrayBuffer)) return close(NODE_SOCKET_CLOSE.unsupported, 'binary messages only');
    if (event.data.byteLength > STREAM_READER_BUFFER) return close(NODE_SOCKET_CLOSE.tooBig, `a message is at most ${STREAM_READER_BUFFER} bytes`);
    handle.write(new Uint8Array(event.data)).catch((error) => {
      logger.debug('a socket could not write its node', { path, error: String(error) });
      close(failed.code, failed.reason);
    });
  });
}

/**
 * Each chunk `handle` reads, one binary message, until it reads its end, `done` aborts or the socket
 * closes; at its end the socket closes with what `ended` says.
 */
function sendReads(socket: WebSocket, handle: ResourceHandleIf, path: string, done: AbortSignal, ended: () => Refusal): void {
  const pump = async () => {
    if (socket.readyState === WebSocket.CONNECTING) await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
    while (!done.aborted && socket.readyState === WebSocket.OPEN) {
      // A slow client's unsent bytes wait in the node's queue for it, where its limit applies.
      while (socket.bufferedAmount > SOCKET_HIGH_WATER && !done.aborted) await new Promise((resolve) => setTimeout(resolve, 10));
      // A read answers at most one write, whole when it is no larger than this.
      const chunk = await handle.read(STREAM_READER_BUFFER, done);
      if (chunk.length === 0) break;
      if (socket.readyState !== WebSocket.OPEN) break;
      socket.send(chunk as Uint8Array<ArrayBuffer>);
    }
    if (done.aborted) return;
    const end = ended();
    closeSocket(socket, end.code, end.reason);
  };
  pump().catch((error) => {
    if (done.aborted) return;
    logger.info('a node ended under its socket', { path, error: String(error) });
    closeSocket(socket, NODE_SOCKET_CLOSE.failed, 'the node failed');
  });
}

/** Why a reader fell behind, as its socket's close frame says it. */
const fellBehind = refusal(NODE_SOCKET_CLOSE.behind, `fell more than ${STREAM_READER_BUFFER} bytes behind`);

/** Each binary message the socket receives is one write of the stream's; the socket's close is the writer's. */
function writeFromSocket(socket: WebSocket, handle: ResourceHandleIf, path: string): void {
  let closing = false;
  const close = (code: number, reason: string) => {
    closing = true;
    closeSocket(socket, code, reason);
  };
  const removed = refusal(NODE_SOCKET_CLOSE.gone, 'the stream was removed');
  writeMessages(socket, handle, path, () => closing, close, removed);
  // The registry closes the writer when the node goes.
  handle.signal.addEventListener('abort', () => {
    if (!closing) close(removed.code, removed.reason);
  }, { once: true });
  socket.addEventListener('close', () => {
    closing = true;
    void handle.close().catch(() => {});
  }, { once: true });
}

/** Each chunk the stream's reader is given is one binary message, until the stream ends or the socket closes. */
function readIntoSocket(socket: WebSocket, handle: ResourceHandleIf, path: string): void {
  const done = new AbortController();
  socket.addEventListener('message', () => closeSocket(socket, NODE_SOCKET_CLOSE.unsupported, 'a reader sends nothing'));
  socket.addEventListener('close', () => {
    done.abort();
    void handle.close().catch(() => {});
  }, { once: true });
  sendReads(socket, handle, path, done.signal, () => isStreamReader(handle) && handle.behind ? fellBehind : refusal(NODE_SOCKET_CLOSE.ended, 'the stream ended'));
}

/**
 * The socket is a connection to a socket node's listener: each binary message it receives one message
 * to the listener, each message from the listener one binary message, until either ends it.
 */
function connectSocket(socket: WebSocket, handle: ResourceHandleIf, path: string): void {
  const done = new AbortController();
  const close = (code: number, reason: string) => {
    done.abort();
    closeSocket(socket, code, reason);
  };
  const ended = () => isSocketConnection(handle) && handle.behind ? fellBehind : refusal(NODE_SOCKET_CLOSE.ended, 'the connection ended');
  writeMessages(socket, handle, path, () => done.signal.aborted, close, refusal(NODE_SOCKET_CLOSE.ended, 'the connection ended'));
  socket.addEventListener('close', () => {
    done.abort();
    void handle.close().catch(() => {});
  }, { once: true });
  sendReads(socket, handle, path, done.signal, ended);
}
