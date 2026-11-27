import { createLogger } from '../../managers/logger/mod.ts';
import { NodeAccessDeniedError, NodeFrozenError, NodeNotFoundError } from '../../vfs/mod.ts';
import { ArchiveTicketStore } from './archive-tickets.ts';
import { clientAddress } from './client-address.ts';
import { handleDav } from './dav/handler.ts';
import { isDavPath } from './dav/paths.ts';
import { DavSignIns } from './dav/sign-in.ts';
import { DownloadLog } from './download-log.ts';
import { handleAppPair, handleAppSession, handleAppSignIn, handleAppUnpair } from './handlers/app.ts';
import { handleDevWrite } from './handlers/dev-write.ts';
import { handleFileSocket, isWebSocketUpgrade } from './handlers/file-socket.ts';
import { handleGetArchive } from './handlers/get-archive.ts';
import { handleGetDefault } from './handlers/get-default.ts';
import { handleGetFile, ticketPreflight } from './handlers/get-file.ts';
import { handleGetInvite } from './handlers/get-invite.ts';
import { handleGetSession, handlePostSession } from './handlers/get-session.ts';
import { handleGetShell } from './handlers/get-shell.ts';
import { handleLive } from './handlers/live.ts';
import { handlePageSignIn } from './handlers/page-sign-in.ts';
import { handlePostArchive } from './handlers/post-archive.ts';
import { handlePostChecksums } from './handlers/post-checksums.ts';
import { handlePostFile } from './handlers/post-file.ts';
import { handlePutFile } from './handlers/put-file.ts';
import { isCrossOrigin } from './same-origin.ts';
import { carriesSessionCookie } from './session.ts';
import { HttpServerConfig } from './types.ts';
import { isUploadPath, Uploads } from './upload/handler.ts';
import { InteractiveTerminalRegistry } from './ws/interactive-terminal-registry.ts';
import { OpenSockets } from './ws/open-sockets.ts';

const logger = createLogger('http-server');

/** Methods that change nothing, which a page of another origin may send with the cookie. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Headers every answer carries: its type is taken as sent, never sniffed; another site learns no more
 * than EiN's origin from a link or a picture, never a path or a ticket in its query; and only EiN's
 * own pages may frame it.
 */
const SECURITY_HEADERS: [string, string][] = [
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ['X-Frame-Options', 'SAMEORIGIN'],
];

/** `response` with `SECURITY_HEADERS`, copied first when its headers may not change; a socket's upgrade as it is. */
function withSecurityHeaders(response: Response): Response {
  if (response.status === 101) return response;
  try {
    for (const [name, value] of SECURITY_HEADERS) response.headers.set(name, value);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    for (const [name, value] of SECURITY_HEADERS) copy.headers.set(name, value);
    return copy;
  }
}

export async function startHttpServer(config: HttpServerConfig): Promise<void> {
  // Per server rather than module-level: a token means nothing outside the process holding
  // the files, and the test harness starts several instances in one.
  const archiveTickets = new ArchiveTicketStore();
  const downloads = new DownloadLog(config.vfs);
  const davSignIns = new DavSignIns(config.vfs, config.env);
  const uploads = new Uploads(config);
  const interactiveTerminals = new InteractiveTerminalRegistry(config);
  const sockets = new OpenSockets();
  // Before `Deno.serve` adds its own listener, so each socket's close frame is this one.
  config.signal.addEventListener('abort', () => sockets.closeAll(1001, 'server stopping'), { once: true });

  const route = async (req: Request, info: Deno.ServeHandlerInfo): Promise<Response> => {
    try {
      const url = new URL(req.url);

      // The shell and a socket act as the session, and a write changes what it may reach: none is
      // open to a page of another origin that the browser hands the cookie to. A socket on a node
      // that carries a ticket or an invitation acts as that and ignores the cookie.
      const socket = isWebSocketUpgrade(req);
      const bearer = url.pathname.startsWith('/file/') && (url.searchParams.has('ticket') || url.searchParams.has('invite'));
      const actsAsSession = url.pathname.startsWith('/__shell') || (socket && !bearer) || !READ_METHODS.has(req.method);
      if (actsAsSession && carriesSessionCookie(config, req.headers) && isCrossOrigin(req.headers)) {
        logger.warn('refused a request from a page of another origin', {
          method: req.method,
          path: url.pathname,
          origin: req.headers.get('origin'),
          from: clientAddress(req.headers, info.remoteAddr),
        });
        return new Response('a page of another origin may not use this session', { status: 403 });
      }

      if (url.pathname.startsWith('/__shell')) {
        return await handleGetShell({ ...config, interactiveTerminals, sockets }, req, url, info.remoteAddr);
      } else if (url.pathname === '/__session' && req.method === 'GET') {
        return await handleGetSession(config, req);
      } else if (url.pathname === '/__session' && req.method === 'POST') {
        return await handlePostSession(config, req);
      } else if (url.pathname.startsWith('/__invite/') && READ_METHODS.has(req.method)) {
        return await handleGetInvite(config, req, url);
      } else if (url.pathname.startsWith('/__page/') && req.method === 'GET') {
        return await handlePageSignIn(config, req, url);
      } else if (url.pathname === '/__app/pair' && req.method === 'POST') {
        return await handleAppPair(config, req, clientAddress(req.headers, info.remoteAddr));
      } else if (url.pathname === '/__app/sign-in' && req.method === 'POST') {
        return await handleAppSignIn(config, req, clientAddress(req.headers, info.remoteAddr));
      } else if (url.pathname === '/__app/session' && req.method === 'GET') {
        return await handleAppSession(config, req, url, clientAddress(req.headers, info.remoteAddr));
      } else if (url.pathname === '/__app/unpair' && req.method === 'POST') {
        return await handleAppUnpair(config, req, clientAddress(req.headers, info.remoteAddr));
      } else if (url.pathname.startsWith('/live/')) {
        return await handleLive(config, req, url);
      } else if (url.pathname.startsWith('/file/')) {
        if (req.method === 'OPTIONS' && url.searchParams.has('ticket')) return ticketPreflight();
        if (socket && req.method === 'GET') return await handleFileSocket({ ...config, sockets }, req, url, clientAddress(req.headers, info.remoteAddr));
        const devWrite = await handleDevWrite(config, req, url, info.remoteAddr);
        if (devWrite) return devWrite;
        if (req.method === 'GET' || req.method === 'HEAD') {
          return await handleGetFile(config, req, url, { downloads, from: clientAddress(req.headers, info.remoteAddr) });
        } else if (req.method === 'PUT') {
          return await handlePutFile(config, req, url);
        } else if (req.method === 'POST') {
          return await handlePostFile(config, req, url);
        }
      } else if (isUploadPath(url.pathname) && req.method !== 'GET') {
        return await uploads.handle(req, url, clientAddress(req.headers, info.remoteAddr));
      } else if (isDavPath(url.pathname)) {
        return await handleDav({ ...config, signIns: davSignIns, downloads }, req, url, info.remoteAddr);
      } else if (url.pathname === '/archive' && req.method === 'POST') {
        return await handlePostArchive(config, req, archiveTickets, clientAddress(req.headers, info.remoteAddr));
      } else if (url.pathname === '/checksums' && req.method === 'POST') {
        return await handlePostChecksums(config, req, clientAddress(req.headers, info.remoteAddr));
      } else if (url.pathname.startsWith('/archive/') && (req.method === 'GET' || req.method === 'HEAD')) {
        return await handleGetArchive(config, req, url, archiveTickets, downloads, clientAddress(req.headers, info.remoteAddr));
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return new Response('Invalid request', { status: 400 });
      }

      return await handleGetDefault(config, req, url);
    } catch (err) {
      if (err instanceof NodeNotFoundError) {
        return new Response('Not Found', { status: 404 });
      }

      if (err instanceof NodeAccessDeniedError) {
        return new Response('Forbidden', { status: 403 });
      }

      if (err instanceof NodeFrozenError) {
        return new Response(err.message, { status: 403 });
      }

      // Top-level error handler for any unhandled errors in the request handler
      logger.error('unhandled error in request handler', { error: err, url: req.url });
      return new Response('Internal Server Error', { status: 500 });
    }
  };
  const handler = async (req: Request, info: Deno.ServeHandlerInfo): Promise<Response> => withSecurityHeaders(await route(req, info));

  const server = await Deno.serve({
    port: config.port,
    signal: config.signal,
    hostname: '0.0.0.0',
    onListen(info) {
      logger.info(`Server started`, { info });
      config.onListen?.(info);
    },
  }, handler);

  try {
    await server.finished;
  } finally {
    await interactiveTerminals.dispose();
  }
}
