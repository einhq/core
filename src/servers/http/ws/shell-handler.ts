/**
 * Interactive shell WebSocket attachment.
 *
 * The shell itself belongs to InteractiveTerminalRegistry and may outlive this
 * transport. This handler only forwards input/control messages and releases
 * its attachment when the socket disappears.
 */

import { createLogger } from '../../../managers/logger/mod.ts';
import { BaseWebSocketHandler, errorMessage, isExpectedWebSocketTeardownError, isWebSocketClosed } from './base-handler.ts';
import { type InteractiveTerminalAttachment, InteractiveTerminalRegistry } from './interactive-terminal-registry.ts';
import type { ShellWebSocketHandlerConfig } from './types.ts';

const logger = createLogger('shell-handler');

type InteractiveShellWebSocketHandlerConfig = ShellWebSocketHandlerConfig & {
  terminals: InteractiveTerminalRegistry;
  /** Missing means a non-resumable interactive client. */
  terminalId?: string;
};

class ShellWebSocketHandler extends BaseWebSocketHandler {
  private attachment?: InteractiveTerminalAttachment;
  private initialization?: Promise<void>;

  constructor(
    config: InteractiveShellWebSocketHandlerConfig,
    ws: WebSocket,
  ) {
    super(config, ws, logger);
  }

  private get terminalConfig(): InteractiveShellWebSocketHandlerConfig {
    return this.config as InteractiveShellWebSocketHandlerConfig;
  }

  async initialize(): Promise<void> {
    return await (this.initialization ??= this.initializeOnce());
  }

  private async initializeOnce(): Promise<void> {
    await this.waitForOpen();

    const resumable = this.terminalConfig.terminalId !== undefined;
    const terminalId = this.terminalConfig.terminalId ?? `legacy-${crypto.randomUUID()}`;
    this.attachment = await this.terminalConfig.terminals.attach(
      this.config.sessionPath,
      terminalId,
      this.ws,
      { resumable, from: this.config.from },
    );

    if (this.closing || isWebSocketClosed(this.ws)) {
      await this.attachment.detach();
      return;
    }

    await this.setReady();
  }

  protected async handleMessage(event: MessageEvent): Promise<void> {
    const data = event.data;
    if (typeof data !== 'string' || !this.attachment) return;

    if (data.startsWith('{')) {
      try {
        const message = JSON.parse(data);
        if (message.type === 'resize') {
          await this.attachment.resize(message.rows, message.cols);
          return;
        }
        if (message.type === 'terminate') {
          await this.attachment.terminate();
          return;
        }
      } catch {
        // Ordinary shell input can begin with `{`; only recognized JSON control
        // messages are intercepted.
      }
    }

    await this.attachment.write(data);
  }

  protected async handleClose(): Promise<void> {
    await this.initialization?.catch(() => {});
    try {
      if (this.closeEvent?.code === 4000) {
        await this.attachment?.terminate();
      } else {
        await this.attachment?.detach();
      }
    } catch (error) {
      if (isExpectedWebSocketTeardownError(this.ws, error)) {
        this.logger.debug('interactive terminal already detached', { error: errorMessage(error) });
      } else {
        this.logger.error('interactive terminal detach failed', { error: errorMessage(error) });
      }
    }
  }
}

export async function handleShellWebSocket(
  config: InteractiveShellWebSocketHandlerConfig,
  ws: WebSocket,
): Promise<ShellWebSocketHandler> {
  const handler = new ShellWebSocketHandler(config, ws);
  await handler.initialize();
  return handler;
}
