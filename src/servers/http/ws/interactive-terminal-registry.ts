import HeadlessXterm from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { ADMIN_ACCESS, GUEST_UID } from '../../../lib/access/mod.ts';
import { createLogger } from '../../../managers/logger/mod.ts';
import { InteractiveShell } from '../../../managers/shell/interactive-shell.ts';
import type { ResourceHandleIf } from '../../../registries/types.ts';
import type { EventSubscription, NodeEvent } from '../../../vfs/mod.ts';
import { NODE_TYPE_SESSION, type SessionAttrs } from '../../../vfs/types/session.ts';
import { removeEphemeralSession } from '../session.ts';
import { errorMessage } from './base-handler.ts';
import type { ShellWebSocketHandlerConfig } from './types.ts';

const logger = createLogger('interactive-terminal-registry');

const DEFAULT_TERMINAL_RECONNECT_GRACE_MS = 300_000;
export const TERMINAL_SCROLLBACK_LINES = 1000;

export type TerminalRestoreMessage = {
  type: 'restore';
  snapshot: string;
  rows: number;
  cols: number;
  pwd: string;
  resumed: boolean;
};

export interface InteractiveTerminalPeer {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

type AttachmentState = {
  token: string;
  peer: InteractiveTerminalPeer;
  resumable: boolean;
  ready: boolean;
};

type InteractiveTerminalAttachOptions = {
  resumable: boolean;
  /** The address of the client attaching, which the shell reports from now on. */
  from?: string;
};

type InteractiveTerminalRegistryConfig = Omit<ShellWebSocketHandlerConfig, 'sessionPath' | 'from'>;

export function terminalReconnectGraceMs(env: Record<string, string>): number {
  const raw = env.CFG_TERMINAL_RECONNECT_GRACE_SEC;
  if (raw === undefined || raw === '') return DEFAULT_TERMINAL_RECONNECT_GRACE_MS;

  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : DEFAULT_TERMINAL_RECONNECT_GRACE_MS;
}

/** One browser attachment to a retained terminal. A stale attachment cannot detach its replacement. */
export class InteractiveTerminalAttachment {
  private detached = false;

  constructor(
    private registry: InteractiveTerminalRegistry,
    private key: string,
    private terminal: RetainedInteractiveTerminal,
    private token: string,
  ) {}

  async write(data: string): Promise<void> {
    await this.terminal.writeInput(this.token, data);
  }

  async resize(rows: number, cols: number): Promise<void> {
    await this.terminal.resize(this.token, rows, cols);
  }

  async detach(): Promise<void> {
    if (this.detached) return;
    this.detached = true;
    await this.terminal.detach(this.token);
  }

  async terminate(): Promise<void> {
    if (this.detached) return;
    this.detached = true;
    await this.registry.terminateAttachment(this.key, this.terminal, this.token);
  }
}

/**
 * Owns interactive shells independently of their WebSocket transports.
 *
 * The HTTP server creates one registry. A resumable entry is scoped by both
 * the authenticated session path and the browser's terminal id; neither alone
 * is sufficient authority to attach to somebody else's shell.
 *
 * Logging out keeps the session path — `logout --session` only turns the
 * session back into a guest's — so the key alone would hand the next page
 * load, or the next person to log in on that browser, the previous user's
 * shells. The registry therefore watches session nodes and ends every
 * terminal of a session whose logged-in user leaves it, or that is deleted.
 */
export class InteractiveTerminalRegistry {
  private terminals = new Map<string, Promise<RetainedInteractiveTerminal>>();
  private disposed = false;
  private sessionWatch: Promise<EventSubscription | undefined>;

  constructor(
    private config: InteractiveTerminalRegistryConfig,
    private reconnectGraceMs = terminalReconnectGraceMs(config.env),
  ) {
    this.sessionWatch = this.watchSessions().catch((error) => {
      logger.error('interactive terminals cannot follow logouts', { error: errorMessage(error) });
      return undefined;
    });
  }

  async attach(
    sessionPath: string,
    terminalId: string,
    peer: InteractiveTerminalPeer,
    opts: InteractiveTerminalAttachOptions,
  ): Promise<InteractiveTerminalAttachment> {
    if (this.disposed) throw new Error('interactive terminal registry is closed');

    const key = `${sessionPath}\0${terminalId}`;
    let pending = this.terminals.get(key);
    const resumed = pending !== undefined;

    if (!pending) {
      const created = RetainedInteractiveTerminal.create(
        { ...this.config, sessionPath },
        this.reconnectGraceMs,
        () => this.remove(key, created),
      );
      pending = created;
      this.terminals.set(key, pending);
    }

    let terminal: RetainedInteractiveTerminal;
    try {
      terminal = await pending;
    } catch (error) {
      if (this.terminals.get(key) === pending) this.terminals.delete(key);
      throw error;
    }

    try {
      const token = await terminal.attach(peer, { ...opts, resumed });
      return new InteractiveTerminalAttachment(this, key, terminal, token);
    } catch (error) {
      // Expiry can win by a few microtasks after we found the entry. Wait for
      // that teardown and retry once so reconnecting sees a fresh shell rather
      // than a failed WebSocket handshake.
      if (!(error instanceof Error && error.message === 'interactive terminal is closed')) throw error;
      await terminal.whenClosed();
      if (this.disposed) throw new Error('interactive terminal registry is closed');
      return await this.attach(sessionPath, terminalId, peer, opts);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await (await this.sessionWatch)?.unsubscribe();
    const pending = [...this.terminals.values()];
    this.terminals.clear();
    const terminals = await Promise.allSettled(pending);
    await Promise.allSettled(terminals.flatMap((result) => result.status === 'fulfilled' ? [result.value.close('shutdown')] : []));
  }

  async terminateAttachment(key: string, terminal: RetainedInteractiveTerminal, token: string): Promise<void> {
    if (!terminal.isAttached(token)) return;
    const pending = this.terminals.get(key);
    if (pending && await pending.catch(() => undefined) === terminal) this.terminals.delete(key);
    await terminal.close('terminate');
  }

  private async watchSessions(): Promise<EventSubscription | undefined> {
    if (!this.config.vfs.subscribe) return undefined;
    return await this.config.vfs.subscribe<SessionAttrs>(() => ADMIN_ACCESS, (event) => {
      if (endsLogin(event)) this.closeSession(event.path);
    }, {
      pathPrefix: this.config.env.SESSIONS_PATH,
      nodeTypes: [NODE_TYPE_SESSION],
      eventTypes: ['updated', 'deleted'],
    });
  }

  /**
   * Not awaited: VFS handlers are, and the mutation that got us here may be
   * `logout --session` typed into one of these very shells, or the unlink of
   * an ephemeral session made by a terminal's own teardown.
   */
  private closeSession(sessionPath: string): void {
    const prefix = `${sessionPath}\0`;
    for (const [key, pending] of this.terminals) {
      if (!key.startsWith(prefix)) continue;
      this.terminals.delete(key);
      pending
        .then((terminal) => terminal.close('logout'))
        .catch((error) => logger.error('closing a logged-out terminal failed', { error: errorMessage(error) }));
    }
  }

  private remove(key: string, pending: Promise<RetainedInteractiveTerminal>): void {
    if (this.terminals.get(key) === pending) this.terminals.delete(key);
  }
}

/** The session's user changed away from a logged-in one (a logout), or the session is gone. */
function endsLogin(event: NodeEvent<SessionAttrs>): boolean {
  if (event.type === 'deleted') return true;
  const before = event.previousNode?.attrs.access?.uid;
  return before !== undefined && before !== GUEST_UID && before !== event.node.attrs.access?.uid;
}

type CloseReason = 'exit' | 'logout' | 'terminate' | 'timeout' | 'shutdown';

class RetainedInteractiveTerminal {
  private shell: InteractiveShell;
  private terminal = new HeadlessXterm.Terminal({
    allowProposedApi: true,
    cols: 80,
    rows: 24,
    scrollback: TERMINAL_SCROLLBACK_LINES,
    convertEol: true,
  });
  private serializer = new SerializeAddon();
  private handles: ResourceHandleIf[] = [];
  private stdin?: ResourceHandleIf;
  private attachment?: AttachmentState;
  private outputChain = Promise.resolve();
  private pumpPromises: Promise<void>[] = [];
  private closeTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private closePromise?: Promise<void>;
  private pwd = '/';

  private constructor(
    private config: ShellWebSocketHandlerConfig,
    private reconnectGraceMs: number,
    private onEnd: () => void,
  ) {
    this.terminal.loadAddon(this.serializer);
    this.shell = new InteractiveShell({
      ...config,
      origin: 'terminal',
      onPwdChange: (path) => this.handlePwd(path),
    });
  }

  static async create(
    config: ShellWebSocketHandlerConfig,
    reconnectGraceMs: number,
    onEnd: () => void,
  ): Promise<RetainedInteractiveTerminal> {
    const terminal = new RetainedInteractiveTerminal(config, reconnectGraceMs, onEnd);
    try {
      await terminal.initialize();
      return terminal;
    } catch (error) {
      await terminal.close('shutdown');
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    await this.shell.open();
    this.pwd = this.shell.getEnv().PWD || '/';

    const stdout = await this.shell.openIOHandle('stdout', 'r');
    const stderr = await this.shell.openIOHandle('stderr', 'r');
    this.stdin = await this.shell.openIOHandle('rawStdin', 'w');
    this.handles.push(stdout, stderr, this.stdin);
    this.pumpPromises.push(this.pump(stdout), this.pump(stderr));

    void this.shell.runInteractive()
      .catch((error) => logger.error('retained interactive shell exited with an error', { error: errorMessage(error) }))
      .finally(() =>
        this.close('exit').catch((error) => {
          logger.error('retained interactive shell cleanup failed', { error: errorMessage(error) });
        })
      );
  }

  async attach(
    peer: InteractiveTerminalPeer,
    opts: InteractiveTerminalAttachOptions & { resumed: boolean },
  ): Promise<string> {
    if (this.closed) throw new Error('interactive terminal is closed');
    if (this.closeTimer !== undefined) {
      clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
    }

    const token = crypto.randomUUID();
    const previous = this.attachment;
    this.attachment = { token, peer, resumable: opts.resumable, ready: !opts.resumable };
    this.shell.from = opts.from;

    if (previous && previous.peer !== peer && previous.peer.readyState === WebSocket.OPEN) {
      previous.peer.close(4001, 'terminal attached elsewhere');
    }

    if (opts.resumable) {
      try {
        await this.enqueue(async () => {
          if (!this.isAttached(token) || peer.readyState !== WebSocket.OPEN) return;
          const message: TerminalRestoreMessage = {
            type: 'restore',
            snapshot: this.serializer.serialize(),
            rows: this.terminal.rows,
            cols: this.terminal.cols,
            pwd: this.pwd,
            resumed: opts.resumed,
          };
          peer.send(JSON.stringify(message));
          if (this.isAttached(token)) this.attachment!.ready = true;
        });
      } catch (error) {
        await this.detach(token);
        throw error;
      }
    }

    return token;
  }

  isAttached(token: string): boolean {
    return this.attachment?.token === token;
  }

  async whenClosed(): Promise<void> {
    await this.closePromise;
  }

  async writeInput(token: string, data: string): Promise<void> {
    if (!this.isAttached(token) || this.closed || !this.stdin) return;
    await this.stdin.write(new TextEncoder().encode(data));
  }

  async resize(token: string, rows: number, cols: number): Promise<void> {
    if (!this.isAttached(token) || this.closed) return;
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 || rows > 1000 || cols > 1000) return;

    await this.enqueue(() => {
      this.terminal.resize(cols, rows);
    });
    await this.shell.resize(rows, cols);
  }

  async detach(token: string): Promise<void> {
    if (!this.isAttached(token) || this.closed) return;
    const resumable = this.attachment!.resumable;
    this.attachment = undefined;

    if (!resumable || this.reconnectGraceMs === 0) {
      await this.close('timeout');
      return;
    }

    this.closeTimer = setTimeout(() => {
      this.closeTimer = undefined;
      this.close('timeout').catch((error) => logger.error('terminal expiry failed', { error: errorMessage(error) }));
    }, this.reconnectGraceMs);
  }

  close(reason: CloseReason): Promise<void> {
    return this.closePromise ??= this.closeOnce(reason);
  }

  private async closeOnce(reason: CloseReason): Promise<void> {
    this.closed = true;
    if (this.closeTimer !== undefined) clearTimeout(this.closeTimer);
    this.closeTimer = undefined;

    const attachment = this.attachment;
    this.attachment = undefined;
    if (attachment?.peer.readyState === WebSocket.OPEN) {
      // A logout ends the shell as surely as `exit` does, and the page should
      // drop the tab rather than reconnect it to a fresh guest shell.
      const ended = reason === 'exit' || reason === 'logout';
      if (ended && attachment.resumable) {
        attachment.peer.send(JSON.stringify({ type: 'terminal-exit' }));
      }
      attachment.peer.close(1000, ended ? 'terminal exited' : 'terminal closed');
    }

    try {
      await this.shell.close();
    } catch (error) {
      logger.error('retained terminal shell close failed', { error: errorMessage(error) });
    }

    await Promise.allSettled(this.handles.map((handle) => handle.close()));
    await Promise.allSettled(this.pumpPromises);
    await this.outputChain.catch(() => {});
    this.serializer.dispose();
    this.terminal.dispose();
    await removeEphemeralSession(this.config, this.config.sessionPath);
    this.onEnd();
  }

  private handlePwd(path: string): void {
    this.pwd = path;
    this.enqueue(() => {
      const attachment = this.attachment;
      if (attachment?.ready && attachment.peer.readyState === WebSocket.OPEN) {
        attachment.peer.send(JSON.stringify({ type: 'pwd', path }));
      }
    });
  }

  private async pump(handle: ResourceHandleIf): Promise<void> {
    const reader = handle.readable.getReader();
    const decoder = new TextDecoder();
    try {
      while (!this.closed) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text) await this.enqueueOutput(text);
      }
      const tail = decoder.decode();
      if (tail) await this.enqueueOutput(tail);
    } catch (error) {
      if (!this.closed && !(error instanceof Error && error.name === 'AbortError')) {
        logger.error('retained terminal output failed', { error: errorMessage(error) });
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Reader may already have been released by teardown.
      }
    }
  }

  private enqueueOutput(text: string): Promise<void> {
    return this.enqueue(async () => {
      await new Promise<void>((resolve) => this.terminal.write(text, resolve));
      const attachment = this.attachment;
      if (attachment?.ready && attachment.peer.readyState === WebSocket.OPEN) {
        attachment.peer.send(text);
      }
    });
  }

  private enqueue(action: () => void | Promise<void>): Promise<void> {
    const next = this.outputChain.then(action);
    this.outputChain = next.catch((error) => logger.error('terminal output sequencing failed', { error: errorMessage(error) }));
    return next;
  }
}
