/**
 * Base WebSocket Handler
 *
 * Abstract base class for WebSocket handlers with shared functionality.
 */

import type { Logger } from '../../../managers/logger/mod.ts';
import { NodeNotFoundError } from '../../../vfs/mod.ts';
import type { ShellWebSocketHandlerConfig } from './types.ts';

class WebSocketClosedError extends Error {
  constructor() {
    super('websocket closed during setup');
    this.name = 'WebSocketClosedError';
  }
}

export function isWebSocketClosed(ws: WebSocket): boolean {
  return ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error instanceof ErrorEvent && error.message) return error.message;
  if (error instanceof Event) return `${error.type || 'websocket'} event`;
  return String(error);
}

export function isExpectedWebSocketTeardownError(ws: WebSocket, error: unknown): boolean {
  return isWebSocketClosed(ws) ||
    error instanceof WebSocketClosedError ||
    error instanceof NodeNotFoundError ||
    (error instanceof Error && error.message === 'shell is closed');
}

export abstract class BaseWebSocketHandler {
  protected ready = false;
  protected closing = false;
  protected closeEvent?: CloseEvent;
  protected messageQueue: MessageEvent[] = [];
  private closePromise?: Promise<void>;

  constructor(
    protected config: ShellWebSocketHandlerConfig,
    protected ws: WebSocket,
    protected logger: Logger,
  ) {
    // Set up WebSocket handlers IMMEDIATELY to capture messages during shell init
    this.ws.onmessage = (event) => {
      if (this.ready) {
        this.handleMessage(event).catch((error) => {
          if (isExpectedWebSocketTeardownError(this.ws, error)) {
            this.logger.debug('websocket message ended during teardown', { error: errorMessage(error) });
          } else {
            this.logger.error('websocket message handling failed', { error: errorMessage(error) });
          }
        });
      } else {
        // Queue messages until shell is ready
        this.messageQueue.push(event);
      }
    };
    this.ws.onerror = this.handleError.bind(this);
    this.ws.onclose = (event) => {
      this.closeEvent = event;
      this.closeOnce().catch((error) => {
        this.logger.error('websocket cleanup failed', { error: errorMessage(error) });
      });
    };
  }

  /**
   * Wait for WebSocket to be open before proceeding
   */
  protected async waitForOpen(): Promise<void> {
    if (isWebSocketClosed(this.ws)) {
      throw new WebSocketClosedError();
    }

    if (this.ws.readyState !== WebSocket.OPEN) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          this.ws.removeEventListener('open', onOpen);
          this.ws.removeEventListener('error', onError);
          this.ws.removeEventListener('close', onClose);
        };
        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onError = (event: Event) => {
          cleanup();
          reject(event);
        };
        const onClose = () => {
          cleanup();
          reject(new WebSocketClosedError());
        };
        this.ws.addEventListener('open', onOpen, { once: true });
        this.ws.addEventListener('error', onError, { once: true });
        this.ws.addEventListener('close', onClose, { once: true });
        // If already open by the time we set the handler
        if (this.ws.readyState === WebSocket.OPEN) {
          onOpen();
        } else if (isWebSocketClosed(this.ws)) {
          onClose();
        }
      });
    }
  }

  protected async setReady(): Promise<void> {
    if (this.closing || isWebSocketClosed(this.ws)) {
      this.messageQueue = [];
      return;
    }

    // Mark as ready and process any queued messages
    this.ready = true;
    for (const event of this.messageQueue) {
      await this.handleMessage(event);
    }
    this.messageQueue = [];
  }

  /**
   * Handle WebSocket error
   */
  protected handleError(event: Event | ErrorEvent): void {
    if (this.closing || isWebSocketClosed(this.ws)) return;

    // ErrorEvent has a message property, regular Event does not
    const errorInfo = 'message' in event ? { message: (event as ErrorEvent).message, type: event.type } : { type: event.type };
    this.logger.error('WebSocket error', errorInfo);
  }

  /**
   * Handle WebSocket close - must be implemented by subclasses
   */
  protected abstract handleClose(): Promise<void>;

  /**
   * Handle WebSocket message - must be implemented by subclasses
   */
  protected abstract handleMessage(event: MessageEvent): Promise<void>;

  /**
   * Dispose handler
   */
  async dispose(): Promise<void> {
    await this.closeOnce();

    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }

  private closeOnce(): Promise<void> {
    this.closing = true;
    return this.closePromise ??= this.handleClose();
  }
}
