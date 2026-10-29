/**
 * API Shell WebSocket Handler
 *
 * Handles WebSocket connections for programmatic command execution.
 * Commands are executed with JSON_OUTPUT=1 and return structured JSON responses.
 * Also supports event subscriptions for remote VFS clients.
 */

import { ulid } from '@std/ulid/ulid';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { createLogger } from '../../../managers/logger/mod.ts';
import { Shell } from '../../../managers/shell/shell.ts';
import { LogEntry, LogHandle } from '../../../registries/log/mod.ts';
import { ResourceSeekMode } from '../../../registries/types.ts';
import {
  EventSubscription,
  EventSubscriptionFilter,
  NodeAccessDeniedError,
  NodeAlreadyExistsError,
  NodeEvent,
  NodeFrozenError,
  NodeInvalidOperationError,
  NodeNotFoundError,
  NodeNotSupportedError,
  NodeTierImmutableError,
  NodeVersionConflictError,
} from '../../../vfs/mod.ts';
import { NODE_TYPE_SESSION, type SessionAttrs } from '../../../vfs/types/session.ts';
import { removeEphemeralSession } from '../session.ts';
import { BaseWebSocketHandler, errorMessage, isExpectedWebSocketTeardownError, isWebSocketClosed } from './base-handler.ts';
import type {
  ShellWebSocketHandlerConfig,
  VfsChildrenMessage,
  VfsCopyMessage,
  VfsCreateMessage,
  VfsEnsureMessage,
  VfsExistsMessage,
  VfsGetMessage,
  VfsLinkMessage,
  VfsRenameMessage,
  VfsResolveIdMessage,
  VfsResolvePathMessage,
  VfsUnlinkMessage,
  VfsUpdateMessage,
} from './types.ts';

const logger = createLogger('api-shell-handler');

export const API_SHELL_MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
// The API shell also carries corpus-sized UI mutations. Face curation, for
// example, updates one VFS node (and publishes one event) per face, so a valid
// merge of a large cluster can take minutes while producing almost no output.
// Keep runaway commands bounded without cutting off those legitimate writes.
export const API_SHELL_EXEC_TIMEOUT_MS = 10 * 60_000;

/** Close code for a socket whose session was ended elsewhere (`user-disable`); the UI reloads as a guest. */
export const SESSION_ENDED_CLOSE_CODE = 4003;

class ApiShellWebSocketHandler extends BaseWebSocketHandler {
  private shell?: Shell;
  private initialization?: Promise<void>;
  private subscriptions: Map<string, EventSubscription> = new Map();
  private logFollows: Map<string, AbortController> = new Map();
  /** Running `exec`s by request id, for `exec.cancel`. */
  private execs: Map<string, AbortController> = new Map();
  private sessionWatch?: EventSubscription;

  constructor(
    config: ShellWebSocketHandlerConfig,
    ws: WebSocket,
  ) {
    super(config, ws, logger);
  }

  async initialize(): Promise<void> {
    return await (this.initialization ??= this.initializeOnce());
  }

  private async initializeOnce(): Promise<void> {
    await this.waitForOpen();

    this.sessionWatch = await this.watchSession();

    // Create non-interactive shell
    this.shell = new Shell({
      ...this.config,
      origin: 'web',
      env: {
        ...this.config.env,
        JSON_OUTPUT: '1',
      },
    });

    await this.shell.open();

    if (this.closing || isWebSocketClosed(this.ws)) {
      return;
    }

    await this.setReady();
  }

  /**
   * Close the socket once its session is expired or removed: the shell took
   * the session's access when it opened and would otherwise keep it.
   */
  private async watchSession(): Promise<EventSubscription | undefined> {
    const sessionPath = this.config.sessionPath;
    if (!this.config.vfs.subscribe || !sessionPath) return undefined;
    return await this.config.vfs.subscribe<SessionAttrs>(() => ADMIN_ACCESS, (event) => {
      if (event.path !== sessionPath) return;
      if (event.type !== 'deleted' && !event.node.attrs.expired) return;
      if (this.closing || isWebSocketClosed(this.ws)) return;
      this.logger.info('session ended, closing API shell', { sessionPath });
      this.ws.close(SESSION_ENDED_CLOSE_CODE, 'session ended');
    }, {
      pathPrefix: sessionPath,
      nodeTypes: [NODE_TYPE_SESSION],
      eventTypes: ['updated', 'deleted'],
    });
  }

  /**
   * Handle incoming message from WebSocket
   */
  protected async handleMessage(event: MessageEvent) {
    const data = event.data;

    if (typeof data !== 'string') {
      return;
    }

    let command = '';
    let msgId = '';
    try {
      const msg = JSON.parse(data);
      command = msg.command;
      msgId = msg.id;

      // The VFS and log messages act with the shell's access: the guest who must sign in
      // gets commands alone, which the shell holds to the ones signing in takes.
      if (msg.type !== 'exec' && msg.type !== 'exec.cancel' && await this.shell!.refusesGuest()) {
        throw new Error('sign in first');
      }

      if (msg.type === 'exec') {
        if (typeof msg.command === 'string') {
          await this.handleExec(msg.id, msg.command, msg.json !== false);
        }
      } else if (msg.type?.startsWith('vfs.')) {
        await this.handleVfsMessage(msg);
      } else if (msg.type === 'exec.cancel') {
        this.handleExecCancel(msg.id, msg.params ?? []);
      } else if (msg.type === 'log.follow') {
        await this.handleLogFollow(msg.id, msg.params ?? []);
      } else if (msg.type === 'log.unfollow') {
        await this.handleLogUnfollow(msg.id, msg.params ?? []);
      } else {
        throw new Error(`Unknown message type: ${msg.type}`);
      }
    } catch (err) {
      const expectedTeardown = isExpectedWebSocketTeardownError(this.ws, err);
      const details = { command, error: errorMessage(err) };
      if (expectedTeardown) {
        this.logger.debug('api shell message abandoned during teardown', details);
      } else {
        this.logger.error('error handling API shell message', details);
      }

      if (isWebSocketClosed(this.ws)) return;
      this.sendResponse({
        type: 'error',
        id: msgId,
        ...this.mapVfsError(err),
      });
    }
  }

  /**
   * Handle exec message - execute command and return result. With `json` false the script
   * runs without `JSON_OUTPUT` and its stdout comes back as the text a terminal would show:
   * the chat drawer's approval card is for a person, not a parser.
   */
  private async handleExec(id: string, command: string, json = true): Promise<void> {
    const controller = new AbortController();
    this.execs.set(id, controller);
    let captured;
    try {
      captured = await this.shell!.runAndCapture(command, undefined, {
        maxOutputBytes: API_SHELL_MAX_CAPTURE_BYTES,
        timeoutMs: API_SHELL_EXEC_TIMEOUT_MS,
        signal: controller.signal,
        ...(json ? {} : { env: { JSON_OUTPUT: null } }),
      });
    } finally {
      this.execs.delete(id);
    }
    const { code, stdout, stderr, errorCode } = captured;

    if (code === 0) {
      // Parse stdout as JSON
      let resultData: unknown = null;
      if (!json) {
        resultData = stdout;
      } else if (stdout.trim()) {
        try {
          resultData = JSON.parse(stdout);
        } catch {
          // If stdout isn't valid JSON, return it as-is
          resultData = stdout;
        }
      }

      this.sendResponse({ type: 'result', id, data: resultData });
    } else {
      this.sendResponse({
        type: 'error',
        id,
        code: errorCode,
        exitCode: code,
        message: stderr || `Command failed with code ${code}`,
        // What a script printed before the line that failed it is part of the story.
        ...(stdout ? { output: stdout } : {}),
        ...(stderr ? { stderr } : {}),
      });
    }
  }

  /**
   * `exec.cancel [execId]`: hang up a running `exec`, as a terminal's Ctrl-C would. The command is
   * sent SIGTERM and stops at its next check; its own response still comes, for a client that
   * has stopped waiting on that id. Cancelling an exec that already finished is not an error.
   */
  private handleExecCancel(requestId: string, params: unknown[]): void {
    const execId = params[0];
    if (typeof execId !== 'string') throw new Error('exec.cancel requires the id of the exec to cancel');
    const controller = this.execs.get(execId);
    controller?.abort();
    this.sendResponse({ type: 'result', id: requestId, data: { cancelled: controller !== undefined } });
  }

  /**
   * Handle VFS message - route to appropriate VFS method handler
   */
  private async handleVfsMessage(msg: { type: string; id: string; params: any }): Promise<void> {
    const method = msg.type.slice(4); // Remove 'vfs.' prefix

    switch (method) {
      case 'get':
        await this.handleVfsGet(msg.id, msg.params);
        break;
      case 'children':
        await this.handleVfsChildren(msg.id, msg.params);
        break;
      case 'exists':
        await this.handleVfsExists(msg.id, msg.params);
        break;
      case 'resolvePath':
        await this.handleVfsResolvePath(msg.id, msg.params);
        break;
      case 'resolveId':
        await this.handleVfsResolveId(msg.id, msg.params);
        break;
      case 'create':
        await this.handleVfsCreate(msg.id, msg.params);
        break;
      case 'ensure':
        await this.handleVfsEnsure(msg.id, msg.params);
        break;
      case 'update':
        await this.handleVfsUpdate(msg.id, msg.params);
        break;
      case 'rename':
        await this.handleVfsRename(msg.id, msg.params);
        break;
      case 'link':
        await this.handleVfsLink(msg.id, msg.params);
        break;
      case 'unlink':
        await this.handleVfsUnlink(msg.id, msg.params);
        break;
      case 'copy':
        await this.handleVfsCopy(msg.id, msg.params);
        break;
      case 'subscribe':
        await this.handleVfsSubscribe(msg.id, msg.params);
        break;
      case 'unsubscribe':
        await this.handleVfsUnsubscribe(msg.id, msg.params);
        break;
      default:
        throw new Error(`Unknown VFS method: ${method}`);
    }
  }

  /**
   * Map VFS errors to WebSocket error responses
   */
  private mapVfsError(error: any): { code?: string; message: string } {
    if (error instanceof NodeNotFoundError) {
      return { code: 'NODE_NOT_FOUND', message: error.message };
    }
    if (error instanceof NodeAlreadyExistsError) {
      return { code: 'NODE_ALREADY_EXISTS', message: error.message };
    }
    if (error instanceof NodeAccessDeniedError) {
      return { code: 'NODE_ACCESS_DENIED', message: error.message };
    }
    if (error instanceof NodeInvalidOperationError) {
      return { code: 'NODE_INVALID_OPERATION', message: error.message };
    }
    if (error instanceof NodeNotSupportedError) {
      return { code: 'NODE_NOT_SUPPORTED', message: error.message };
    }
    if (error instanceof NodeFrozenError) {
      return { code: 'NODE_FROZEN', message: error.message };
    }
    if (error instanceof NodeTierImmutableError) {
      return { code: 'NODE_TIER_IMMUTABLE', message: error.message };
    }
    if (error instanceof NodeVersionConflictError) {
      return { code: 'NODE_VERSION_CONFLICT', message: error.message };
    }
    return { message: error instanceof Error ? error.message : String(error) };
  }

  // ===== VFS Operation Handlers =====

  private async handleVfsGet(id: string, params: VfsGetMessage['params']): Promise<void> {
    const access = this.shell!.getAccess();
    const node = await this.config.vfs.get(access, params[0], params[1]);
    this.sendResponse({ type: 'result', id, data: node });
  }

  private async handleVfsChildren(id: string, params: VfsChildrenMessage['params']): Promise<void> {
    const access = this.shell!.getAccess();
    const children = await this.config.vfs.children(access, params[0], params[1]);
    this.sendResponse({ type: 'result', id, data: children });
  }

  private async handleVfsExists(id: string, params: VfsExistsMessage['params']): Promise<void> {
    const access = this.shell!.getAccess();
    const exists = await this.config.vfs.exists(access, params[0], params[1]);
    this.sendResponse({ type: 'result', id, data: exists });
  }

  private async handleVfsResolvePath(id: string, params: VfsResolvePathMessage['params']): Promise<void> {
    const access = this.shell!.getAccess();
    const entry = await this.config.vfs.resolvePath(access, params[0], params[1]);
    this.sendResponse({
      type: 'result',
      id,
      data: {
        id: entry.id,
        vfsAbsPath: entry.vfsAbsPath,
        absPath: entry.absPath,
      },
    });
  }

  private async handleVfsResolveId(id: string, params: VfsResolveIdMessage['params']): Promise<void> {
    const access = this.shell!.getAccess();
    const entries = await this.config.vfs.resolveId(access, params[0]);
    this.sendResponse({ type: 'result', id, data: entries });
  }

  private async handleVfsCreate(id: string, params: VfsCreateMessage['params']): Promise<void> {
    const access = this.shell!.getAccess();
    const node = await this.config.vfs.create(access, params[0], params[1], params[2], params[3]);
    this.sendResponse({ type: 'result', id, data: node });
  }

  private async handleVfsEnsure(id: string, params: VfsEnsureMessage['params']): Promise<void> {
    const access = this.shell!.getAccess();
    const node = await this.config.vfs.ensure(access, params[0], params[1], params[2], params[3]);
    this.sendResponse({ type: 'result', id, data: node });
  }

  private async handleVfsUpdate(id: string, params: VfsUpdateMessage['params']): Promise<void> {
    const access = this.shell!.getAccess();
    const node = await this.config.vfs.update(access, params[0], params[1]);
    this.sendResponse({ type: 'result', id, data: node });
  }

  private async handleVfsRename(id: string, params: VfsRenameMessage['params']): Promise<void> {
    const access = this.shell!.getAccess();
    const node = await this.config.vfs.rename(access, params[0], params[1], params[2], params[3], params[4]);
    this.sendResponse({ type: 'result', id, data: node });
  }

  private async handleVfsLink(id: string, params: VfsLinkMessage['params']): Promise<void> {
    const access = this.shell!.getAccess();
    const node = await this.config.vfs.link(access, params[0], params[1], params[2], params[3]);
    this.sendResponse({ type: 'result', id, data: node });
  }

  private async handleVfsUnlink(id: string, params: VfsUnlinkMessage['params']): Promise<void> {
    const access = this.shell!.getAccess();
    const result = await this.config.vfs.unlink(access, params[0], params[1], params[2]);
    this.sendResponse({ type: 'result', id, data: result });
  }

  private async handleVfsCopy(id: string, params: VfsCopyMessage['params']): Promise<void> {
    const access = this.shell!.getAccess();
    const node = await this.config.vfs.copy(access, params[0], params[1], params[2], params[3]);
    this.sendResponse({ type: 'result', id, data: node });
  }

  /**
   * Handle subscribe message - subscribe to VFS events and forward to client
   */
  private async handleVfsSubscribe(
    requestId: string,
    params: [EventSubscriptionFilter?],
  ): Promise<void> {
    if (!this.config.vfs.subscribe) {
      this.sendResponse({
        type: 'error',
        id: requestId,
        message: 'VFS does not support event subscriptions',
      });
      return;
    }

    const filter = params[0];
    const subscriptionId = ulid();

    try {
      const subscription = await this.config.vfs.subscribe(() => this.shell!.getAccess(), async (event: NodeEvent) => {
        this.sendResponse({
          type: 'event',
          subscriptionId,
          event,
        });
      }, filter);

      this.subscriptions.set(subscriptionId, subscription);

      this.sendResponse({
        type: 'result',
        id: requestId,
        data: { subscriptionId },
      });

      logger.debug('Client subscribed to events', { subscriptionId, filter });
    } catch (err) {
      this.sendResponse({
        type: 'error',
        id: requestId,
        message: err instanceof Error ? err.message : 'Failed to subscribe',
      });
    }
  }

  /**
   * Handle log.follow — stream log entries (history + live tail) to the
   * client. Opens the log read-only and loops blocking reads (LISTEN/NOTIFY)
   * until unfollowed or the socket closes; each batch is pushed as an event
   * message carrying `entries` ({id, createdAt, data}).
   *
   * `tail` bounds the history first: a read-mode handle starts at entry 1, so
   * without it every subscribe — and every reconnect — replays the whole log
   * before reaching live. On /var/logs/system that is the busiest log on the
   * instance. Same seek as `tail -n`, and a failure is ignored the same way,
   * because a log shorter than the request leaves the cursor at the start,
   * which is the right answer.
   */
  private async handleLogFollow(requestId: string, params: [string, { tail?: number }?]): Promise<void> {
    const path = params[0];
    if (typeof path !== 'string') {
      throw new Error('log.follow requires a log path');
    }

    const tail = params[1]?.tail;

    const access = this.shell!.getAccess();
    const handle = await this.config.vfs.open(access, path, { mode: 'r' });

    if (!(handle instanceof LogHandle)) {
      await handle.close();
      throw new Error(`${path}: not a log`);
    }

    if (typeof tail === 'number' && tail > 0) {
      try {
        await handle.seek(-tail, ResourceSeekMode.End);
      } catch {
        // Shorter than the window asked for — read it all.
      }
    }

    const subscriptionId = ulid();
    const controller = new AbortController();
    this.logFollows.set(subscriptionId, controller);

    this.sendResponse({
      type: 'result',
      id: requestId,
      data: { subscriptionId },
    });

    // Detached pump: handleMessage must not block on the tail loop
    (async () => {
      try {
        while (!controller.signal.aborted) {
          const entries = await handle.readEntries(500, controller.signal);
          if (controller.signal.aborted) break;
          if (entries.length === 0) continue; // notify race, re-read

          this.sendResponse({
            type: 'event',
            subscriptionId,
            event: { entries },
          });
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          logger.error('log.follow pump failed', { path, subscriptionId, error: err });
        }
      } finally {
        this.logFollows.delete(subscriptionId);
        try {
          await handle.close();
        } catch {
          // already closed
        }
      }
    })();

    logger.debug('Client following log', { path, subscriptionId });
  }

  /**
   * Handle log.unfollow — stop a log.follow stream
   */
  private async handleLogUnfollow(requestId: string, params: [string]): Promise<void> {
    const subscriptionId = params[0];
    const controller = this.logFollows.get(subscriptionId);

    if (!controller) {
      this.sendResponse({
        type: 'error',
        id: requestId,
        message: `unknown log follow: ${subscriptionId}`,
      });
      return;
    }

    controller.abort();
    this.logFollows.delete(subscriptionId);

    this.sendResponse({
      type: 'result',
      id: requestId,
      data: { unfollowed: true },
    });
  }

  /**
   * Handle unsubscribe message - cancel event subscription
   */
  private async handleVfsUnsubscribe(
    requestId: string,
    params: [string],
  ): Promise<void> {
    const subscriptionId = params[0];
    const subscription = this.subscriptions.get(subscriptionId);

    if (!subscription) {
      this.sendResponse({
        type: 'error',
        id: requestId,
        message: `Unknown subscription: ${subscriptionId}`,
      });
      return;
    }

    try {
      await subscription.unsubscribe();
      this.subscriptions.delete(subscriptionId);

      this.sendResponse({
        type: 'result',
        id: requestId,
        data: null,
      });

      logger.debug('Client unsubscribed from events', { subscriptionId });
    } catch (err) {
      this.sendResponse({
        type: 'error',
        id: requestId,
        message: err instanceof Error ? err.message : 'Failed to unsubscribe',
      });
    }
  }

  /**
   * Send a response, handling JSON serialization errors
   */
  private sendResponse(response: {
    type: string;
    id?: string;
    code?: string;
    /** For a failed exec: the command's exit status, beside the VFS-style `code`. */
    exitCode?: number;
    /** For a failed exec: its stdout up to the failure, and its stderr as it was. */
    output?: string;
    stderr?: string;
    data?: unknown;
    message?: string;
    subscriptionId?: string;
    event?: NodeEvent | { entries: LogEntry[] };
  }): void {
    if (this.ws.readyState !== WebSocket.OPEN) {
      this.logger.debug('dropping API shell response after socket close', { type: response.type, id: response.id });
      return;
    }

    try {
      this.ws.send(JSON.stringify(response));
    } catch (err) {
      this.logger.error('Failed to serialize response', {
        error: err instanceof Error ? err.message : String(err),
        responseType: response.type,
        id: response.id,
      });
      // Send a simple error response that we know will serialize
      this.ws.send(JSON.stringify({
        type: 'error',
        id: response.id,
        message: 'Failed to serialize response: ' + (err instanceof Error ? err.message : String(err)),
      }));
    }
  }

  /**
   * Handle WebSocket close
   */
  protected async handleClose() {
    await this.initialization?.catch(() => {});

    await this.sessionWatch?.unsubscribe().catch(() => {});

    // Stop all log follow pumps (they close their own handles)
    for (const controller of this.logFollows.values()) {
      controller.abort();
    }
    this.logFollows.clear();

    // Unsubscribe from all active subscriptions
    for (const [id, subscription] of this.subscriptions) {
      try {
        await subscription.unsubscribe();
        logger.debug('Cleaned up subscription on close', { subscriptionId: id });
      } catch (err) {
        this.logger.error(`Error unsubscribing ${id}:`, err);
      }
    }
    this.subscriptions.clear();

    // Close shell
    if (this.shell) {
      try {
        await this.shell.close();
      } catch (err) {
        if (isExpectedWebSocketTeardownError(this.ws, err)) {
          this.logger.debug('API shell already gone during close', { error: errorMessage(err) });
        } else {
          this.logger.error('error closing API shell', { error: errorMessage(err) });
        }
      }
    }

    // No-op for a cookie-backed session; drops one this process invented for a
    // client that could never have received the cookie.
    await removeEphemeralSession(this.config, this.config.sessionPath);
  }
}

/**
 * Create API shell WebSocket handler for a connection
 */
export async function handleApiShellWebSocket(
  config: ShellWebSocketHandlerConfig,
  ws: WebSocket,
): Promise<ApiShellWebSocketHandler> {
  const handler = new ApiShellWebSocketHandler(config, ws);
  await handler.initialize();
  return handler;
}
