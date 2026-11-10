import { createLogger } from '../../managers/logger/mod.ts';
import { NodeAccessDeniedError, NodeFrozenError, NodeNotFoundError } from '../../vfs/mod.ts';
import { ArchiveTicketStore } from './archive-tickets.ts';
import { clientAddress } from './client-address.ts';
import { DownloadLog } from './download-log.ts';
import { handleDevWrite } from './handlers/dev-write.ts';
import { handleGetArchive } from './handlers/get-archive.ts';
import { handleGetDefault } from './handlers/get-default.ts';
import { handleGetFile } from './handlers/get-file.ts';
import { handleGetSession } from './handlers/get-session.ts';
import { handleGetShell } from './handlers/get-shell.ts';
import { handlePostArchive } from './handlers/post-archive.ts';
import { handlePostFile } from './handlers/post-file.ts';
import { handlePutFile } from './handlers/put-file.ts';
import { handleStreamLive } from './handlers/stream.ts';
import { HttpServerConfig } from './types.ts';
import { InteractiveTerminalRegistry } from './ws/interactive-terminal-registry.ts';

const logger = createLogger('http-server');

export async function startHttpServer(config: HttpServerConfig): Promise<void> {
  // Per server rather than module-level: a token means nothing outside the process holding
  // the files, and the test harness starts several instances in one.
  const archiveTickets = new ArchiveTicketStore();
  const downloads = new DownloadLog(config.vfs);
  const interactiveTerminals = new InteractiveTerminalRegistry(config);

  const handler = async (req: Request, info: Deno.ServeHandlerInfo): Promise<Response> => {
    try {
      const url = new URL(req.url);

      if (url.pathname.startsWith('/__shell')) {
        return await handleGetShell({ ...config, interactiveTerminals }, req, url, info.remoteAddr);
      } else if (url.pathname === '/__session' && req.method === 'GET') {
        return await handleGetSession(config, req);
      } else if (url.pathname.startsWith('/stream/') && req.method === 'GET') {
        return await handleStreamLive(config, req, url);
      } else if (url.pathname.startsWith('/file/')) {
        const devWrite = await handleDevWrite(config, req, url, info.remoteAddr);
        if (devWrite) return devWrite;
        if (req.method === 'GET' || req.method === 'HEAD') {
          return await handleGetFile(config, req, url, { downloads, from: clientAddress(req.headers, info.remoteAddr) });
        } else if (req.method === 'PUT') {
          return await handlePutFile(config, req, url);
        } else if (req.method === 'POST') {
          return await handlePostFile(config, req, url);
        }
      } else if (url.pathname === '/archive' && req.method === 'POST') {
        return await handlePostArchive(config, req, archiveTickets);
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
