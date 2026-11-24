import { isVisitor } from '../../../lib/access/mod.ts';
import { createLogger } from '../../../managers/logger/mod.ts';
import { clientAddress } from '../client-address.ts';
import { getSession } from '../session.ts';
import { HttpServerConfig } from '../types.ts';
import { handleApiShellWebSocket, handleShellWebSocket } from '../ws/mod.ts';
import { errorMessage, isExpectedWebSocketTeardownError } from '../ws/base-handler.ts';
import type { InteractiveTerminalRegistry } from '../ws/interactive-terminal-registry.ts';
import type { OpenSockets } from '../ws/open-sockets.ts';

const logger = createLogger('http');

type ShellHttpServerConfig = HttpServerConfig & { interactiveTerminals: InteractiveTerminalRegistry; sockets: OpenSockets };

const TERMINAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export async function handleGetShell(config: ShellHttpServerConfig, req: Request, url: URL, remoteAddr: Deno.Addr): Promise<Response> {
  if (req.headers.get('upgrade') !== 'websocket') {
    return new Response('Only websocket connections can be made on this path', { status: 400 });
  }

  const from = clientAddress(req.headers, remoteAddr);

  const mode = url.searchParams.get('mode');
  const terminalId = url.searchParams.get('terminalId') ?? undefined;
  if (mode === 'interactive' && terminalId !== undefined && !TERMINAL_ID_PATTERN.test(terminalId)) {
    return new Response('Invalid terminal id', { status: 400 });
  }

  // Asked first without writing anything, so a refused visitor costs no session.
  const visitor = isVisitor((await getSession(config, req.headers, { create: false, refresh: false })).access) ? from ?? '' : undefined;
  if (visitor !== undefined && !config.sockets.admitsVisitor(visitor)) {
    logger.warn('refused a visitor socket over the limit', { from });
    return new Response('too many connections', { status: 429, headers: { 'Retry-After': '60' } });
  }

  const { sessionPath } = await getSession(config, req.headers, { socket: true });
  const { socket, response } = config.sockets.upgrade(req, visitor);

  if (mode === 'interactive') {
    // Handle shell WebSocket. Setup runs async for the session lifetime; a
    // failure (e.g. the client disconnects mid-init, tearing down the tty
    // buffers) must not become an uncaught rejection that crashes the server.
    handleShellWebSocket({
      cem: config.cem,
      vfs: config.vfs,
      bufferManager: config.bufferManager,
      env: config.env,
      sessionPath,
      from,
      terminals: config.interactiveTerminals,
      terminalId,
    }, socket).catch((err) => {
      const details = { error: errorMessage(err), sessionPath };
      if (isExpectedWebSocketTeardownError(socket, err)) {
        logger.debug('interactive shell setup ended during teardown', details);
      } else {
        logger.error('interactive shell setup failed', details);
      }
      try {
        socket.close();
      } catch { /* already closed */ }
    });

    logger.info('Interactive client connected', { sessionPath, from });

    return response;
  }

  // Handle API shell WebSocket (see note above about not crashing on setup failure).
  handleApiShellWebSocket({
    cem: config.cem,
    vfs: config.vfs,
    bufferManager: config.bufferManager,
    env: config.env,
    sessionPath,
    from,
  }, socket).catch((err) => {
    const details = { error: errorMessage(err), sessionPath };
    if (isExpectedWebSocketTeardownError(socket, err)) {
      logger.debug('api shell setup ended during teardown', details);
    } else {
      logger.error('api shell setup failed', details);
    }
    try {
      socket.close();
    } catch { /* already closed */ }
  });

  logger.info('Non-interactive client connected', { sessionPath, from });

  return response;
}
