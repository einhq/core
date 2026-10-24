type PwdHandler = (path: string) => void;
type DataHandler = (data: string) => void;
type ConnectStateHandler = (connected: boolean) => void;
type TerminalExitHandler = () => void;
type TerminalConflictHandler = () => void;

const TERMINAL_ATTACHED_ELSEWHERE_CLOSE_CODE = 4001;

export type TerminalRestore = {
  snapshot: string;
  rows: number;
  cols: number;
  pwd: string;
  resumed: boolean;
};

type RestoreHandler = (restore: TerminalRestore) => void | Promise<void>;

interface WSMessage {
  type: string;
  [key: string]: unknown;
}

/** WebSocket transport for one resumable interactive terminal. */
export class WebSocketClient {
  private socket: WebSocket | null = null;
  private queue: string[] = [];
  private pendingResize?: string;
  private incomingQueue: string[] = [];
  private reconnectInterval = 1000;
  private reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private connected = false;
  private stopped = false;
  private terminalEnded = false;
  private lastCols = 0;
  private lastRows = 0;
  private pendingRestore?: TerminalRestore;
  private messageChain = Promise.resolve();

  private onPwdHandler?: PwdHandler;
  private onDataHandler?: DataHandler;
  private onConnectStateHandler?: ConnectStateHandler;
  private onRestoreHandler?: RestoreHandler;
  private onTerminalExitHandler?: TerminalExitHandler;
  private onTerminalConflictHandler?: TerminalConflictHandler;

  constructor(
    private url: string,
    private origin: Pick<Location, 'protocol' | 'host'> = globalThis.location,
  ) {}

  public isConnected(): boolean {
    return this.connected;
  }

  public connect(): void {
    if (this.socket && (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN)) return;
    this.stopped = false;
    this.terminalEnded = false;

    const protocol = this.origin.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${this.origin.host}${this.url}`);
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      console.log('[WebSocket] Connected, restoring terminal');
    };

    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.messageChain = this.messageChain
        .then(() => this.handleMessage(event, socket))
        .catch((error) => console.error('[WebSocket] Message handling failed:', error));
    };

    socket.onerror = (err) => {
      if (this.socket === socket) console.error('[WebSocket] Error:', err);
    };

    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.setConnected(false);
      this.pendingRestore = undefined;
      this.incomingQueue = [];
      this.lastCols = 0;
      this.lastRows = 0;

      if (this.stopped || this.terminalEnded) return;

      // Another live page attached this terminal id. Retrying would make both
      // pages continually evict each other, so let the UI fork this copied
      // workspace to fresh ids instead.
      if (event.code === TERMINAL_ATTACHED_ELSEWHERE_CLOSE_CODE) {
        this.stopped = true;
        this.onTerminalConflictHandler?.();
        return;
      }

      console.warn('[WebSocket] Disconnected, retrying...');
      if (this.reconnectTimer === null) {
        this.reconnectTimer = globalThis.setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, this.reconnectInterval);
      }
    };
  }

  private async handleMessage(event: MessageEvent, socket: WebSocket): Promise<void> {
    const data = event.data;

    if (typeof data === 'string' && data.startsWith('{')) {
      try {
        const msg = JSON.parse(data) as WSMessage;
        if (msg.type === 'restore') {
          const restore: TerminalRestore = {
            snapshot: String(msg.snapshot ?? ''),
            rows: Number(msg.rows),
            cols: Number(msg.cols),
            pwd: String(msg.pwd ?? '/'),
            resumed: Boolean(msg.resumed),
          };
          if (!this.onRestoreHandler) {
            this.pendingRestore = restore;
            return;
          }
          await this.applyRestore(restore, socket);
          return;
        }
        if (msg.type === 'pwd') {
          this.onPwdHandler?.(String(msg.path ?? '/'));
          return;
        }
        if (msg.type === 'terminal-exit') {
          this.terminalEnded = true;
          this.onTerminalExitHandler?.();
          return;
        }
      } catch {
        // Raw terminal output is allowed to begin with `{`.
      }
    }

    if (!this.connected || !this.onDataHandler) {
      if (typeof data === 'string') this.incomingQueue.push(data);
      return;
    }
    this.onDataHandler(data);
  }

  private async applyRestore(restore: TerminalRestore, socket: WebSocket): Promise<void> {
    if (this.socket !== socket || !this.onRestoreHandler) return;
    await this.onRestoreHandler(restore);
    if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;

    if (this.pendingResize) {
      socket.send(this.pendingResize);
      this.pendingResize = undefined;
    }
    this.setConnected(true);
    for (const message of this.queue.splice(0)) socket.send(message);
    if (this.onDataHandler) {
      for (const data of this.incomingQueue.splice(0)) this.onDataHandler(data);
    }
  }

  sendJSON(msg: WSMessage): void {
    this.send(JSON.stringify(msg));
  }

  send(data: string): void {
    if (this.connected && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(data);
    } else {
      this.queue.push(data);
    }
  }

  sendResize(cols: number, rows: number): void {
    if (cols === this.lastCols && rows === this.lastRows) return;
    this.lastCols = cols;
    this.lastRows = rows;
    const message = JSON.stringify({ type: 'resize', cols, rows });
    if (this.connected && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(message);
    } else {
      // Only the latest dimensions matter, and they must reach the server
      // before input queued during restore.
      this.pendingResize = message;
    }
  }

  onPwd(handler?: PwdHandler): void {
    this.onPwdHandler = handler;
  }

  onData(handler?: DataHandler): void {
    this.onDataHandler = handler;
    if (handler && this.connected) {
      for (const data of this.incomingQueue.splice(0)) handler(data);
    }
  }

  onConnectState(handler?: ConnectStateHandler): void {
    this.onConnectStateHandler = handler;
    if (handler) handler(this.connected);
  }

  onRestore(handler?: RestoreHandler): void {
    this.onRestoreHandler = handler;
    if (!handler || !this.pendingRestore || !this.socket) return;

    const restore = this.pendingRestore;
    const socket = this.socket;
    this.pendingRestore = undefined;
    this.messageChain = this.messageChain
      .then(() => this.applyRestore(restore, socket))
      .catch((error) => console.error('[WebSocket] Restore failed:', error));
  }

  onTerminalExit(handler?: TerminalExitHandler): void {
    this.onTerminalExitHandler = handler;
  }

  onTerminalConflict(handler?: TerminalConflictHandler): void {
    this.onTerminalConflictHandler = handler;
  }

  /** Close this browser transport while leaving the server shell eligible for reattachment. */
  close(): void {
    this.stop(false);
  }

  /** Explicitly close the terminal tab and its server-side shell. */
  terminate(): void {
    this.stop(true);
  }

  private stop(terminate: boolean): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const socket = this.socket;
    this.socket = null;
    this.setConnected(false);
    if (!socket) return;

    if (terminate && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'terminate' }));
    }
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(terminate ? 4000 : 1000, terminate ? 'terminal closed' : 'client detached');
    }
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.onConnectStateHandler?.(connected);
  }
}
