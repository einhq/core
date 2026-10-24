import { createLogger } from '../../../managers/logger/mod.ts';
import { clientAddress } from '../client-address.ts';
import { getSession } from '../session.ts';
import { HttpServerConfig } from '../types.ts';
import { handleApiShellWebSocket, handleShellWebSocket } from '../ws/mod.ts';
import { errorMessage, isExpectedWebSocketTeardownError } from '../ws/base-handler.ts';
import type { InteractiveTerminalRegistry } from '../ws/interactive-terminal-registry.ts';

const logger = createLogger('http');

type ShellHttpServerConfig = HttpServerConfig & { interactiveTerminals: InteractiveTerminalRegistry };

const TERMINAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export async function handleGetShell(config: ShellHttpServerConfig, req: Request, url: URL, remoteAddr: Deno.Addr): Promise<Response> {
  if (req.headers.get('upgrade') !== 'websocket') {
    return new Response('Only websocket connections can be made on this path', { status: 400 });
  }

  const from = clientAddress(req.headers, remoteAddr);

  const mode = url.searchParams.get('mode');

  if (mode === 'interactive') {
    const terminalId = url.searchParams.get('terminalId') ?? undefined;
    if (terminalId !== undefined && !TERMINAL_ID_PATTERN.test(terminalId)) {
      return new Response('Invalid terminal id', { status: 400 });
    }

    const { sessionPath } = await getSession(config, req.headers, { ephemeral: true });
    const { socket, response } = Deno.upgradeWebSocket(req);

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

  const { sessionPath } = await getSession(config, req.headers, { ephemeral: true });
  const { socket, response } = Deno.upgradeWebSocket(req);

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
