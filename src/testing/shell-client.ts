/**
 * Shell Client
 *
 * WebSocket client for the /__shell endpoint (API mode).
 * Provides programmatic command execution for testing.
 */

export type CommandResult = {
  id: string;
  success: boolean;
  data: unknown;
  error?: string;
  rawResponse: unknown;
};

export type ExecOptions = {
  /**
   * Milliseconds before the request fails, 60 s by default: a bound on a hung command, not on a
   * slow one, since the pg tier runs every test file at once and a fast command can take seconds.
   */
  timeout?: number;
  /** `false` runs without JSON_OUTPUT, as the chat's approval card does: stdout comes back as text. */
  json?: boolean;
  /** Aborting sends `exec.cancel` for this exec; the result is still the exec's own answer. */
  signal?: AbortSignal;
};

export class ShellClient {
  private ws: WebSocket;
  private requestId = 0;
  private pending = new Map<
    string,
    {
      resolve: (result: CommandResult) => void;
      reject: (error: Error) => void;
    }
  >();
  private eventHandlers = new Map<string, (event: unknown) => void>();
  /** Resolves with the close code once the connection closes, from either end. */
  readonly closed: Promise<number>;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.closed = new Promise((resolve) => ws.addEventListener('close', (event) => resolve(event.code), { once: true }));
    this.setupHandlers();
  }

  /**
   * Connect to the API shell endpoint
   */
  static async connect(baseUrl: string): Promise<ShellClient> {
    const wsUrl = baseUrl.replace('http', 'ws') + '/__shell';
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket connection timeout'));
      }, 5000);

      ws.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('WebSocket connection failed'));
      };
    });

    // No settle wait: the server queues anything sent before its shell is open
    // (`BaseWebSocketHandler`), so the first request can go straight away.
    return new ShellClient(ws);
  }

  /**
   * Send a raw request message and wait for its result
   */
  private request(payload: Record<string, unknown>, options: ExecOptions = {}): Promise<CommandResult> {
    const timeout = options.timeout ?? 60_000;
    const id = `req-${++this.requestId}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timed out after ${timeout}ms: ${JSON.stringify(payload)}`));
      }, timeout);

      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.ws.send(JSON.stringify({ ...payload, id }));
      options.signal?.addEventListener('abort', () => {
        if (this.pending.has(id)) this.request({ type: 'exec.cancel', params: [id] }).catch(() => {});
      }, { once: true });
    });
  }

  /**
   * Execute a command and wait for result
   */
  exec(command: string, options: ExecOptions = {}): Promise<CommandResult> {
    return this.request({ type: 'exec', command, ...(options.json === false ? { json: false } : {}) }, options);
  }

  /** Send a VFS message (`vfs.get`, `vfs.children`, …) with `params` and wait for its result. */
  vfs(method: string, params: unknown[], options?: ExecOptions): Promise<CommandResult> {
    return this.request({ type: `vfs.${method}`, params }, options);
  }

  /**
   * Follow a log node (log.follow): the server streams existing entries and
   * live appends as event messages. Returns an unfollow function.
   */
  async followLog(path: string, onEvent: (event: unknown) => void, options?: ExecOptions): Promise<() => Promise<void>> {
    const result = await this.request({ type: 'log.follow', params: [path] }, options);
    if (!result.success) {
      throw new Error(result.error || 'log.follow failed');
    }

    const { subscriptionId } = result.data as { subscriptionId: string };
    this.eventHandlers.set(subscriptionId, onEvent);

    return async () => {
      this.eventHandlers.delete(subscriptionId);
      await this.request({ type: 'log.unfollow', params: [subscriptionId] });
    };
  }

  /**
   * Execute command and return parsed JSON data
   */
  async execJson<T = unknown>(command: string, options?: ExecOptions): Promise<T> {
    const result = await this.exec(command, options);
    if (!result.success) {
      throw new Error(result.error || 'Command failed');
    }
    return result.data as T;
  }

  /**
   * Execute command and return string output
   */
  async execString(command: string, options?: ExecOptions): Promise<string> {
    const result = await this.exec(command, options);
    if (!result.success) {
      throw new Error(result.error || 'Command failed');
    }
    return typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
  }

  /**
   * Close the connection
   */
  close(): void {
    this.ws.close();
  }

  private setupHandlers(): void {
    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'event' && msg.subscriptionId) {
          this.eventHandlers.get(msg.subscriptionId)?.(msg.event);
          return;
        }

        const pending = this.pending.get(msg.id);

        if (pending) {
          this.pending.delete(msg.id);

          if (msg.type === 'result') {
            pending.resolve({
              id: msg.id,
              success: true,
              data: msg.data,
              rawResponse: msg,
            });
          } else if (msg.type === 'error') {
            pending.resolve({
              id: msg.id,
              success: false,
              data: null,
              error: msg.message,
              rawResponse: msg,
            });
          }
        }
      } catch {
        // Non-JSON message, ignore
      }
    };

    this.ws.onerror = () => {
      // Reject all pending requests
      for (const [_id, pending] of this.pending) {
        pending.reject(new Error('WebSocket error'));
      }
      this.pending.clear();
    };

    this.ws.onclose = () => {
      // Reject all pending requests
      for (const [_id, pending] of this.pending) {
        pending.reject(new Error('WebSocket closed'));
      }
      this.pending.clear();
    };
  }
}
