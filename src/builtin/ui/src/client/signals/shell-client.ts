import { signal } from '@preact/signals-react';

/**
 * Shell client connection status
 */
export const shellClientConnected = signal(false);

/**
 * Bumped every time the socket comes back up. Views that hold server-derived
 * state watch this to resync: a reconnect means new subscription ids and an
 * unknown amount of missed traffic, so whatever they were showing is stale.
 */
export const shellClientEpoch = signal(0);

let ws: WebSocket | null = null;
let requestId = 0;
const pendingRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}>();
// Push-event subscribers (log.follow streams, vfs.subscribe), keyed by server
// subscriptionId. Cleared on close — the ids belong to that socket.
const subscriptionHandlers = new Map<string, (event: unknown) => void>();

let reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
let closedByUs = false;
const RECONNECT_DELAY_MS = 2000;
/** The server closed the socket because its session was ended (the account was disabled or deleted). */
const SESSION_ENDED_CLOSE_CODE = 4003;

// Resolves when the socket is OPEN. execCommand awaits this so calls made
// before the connection is established (e.g. a data hook firing on a deep-link
// reload) queue instead of failing with "not connected".
let connectPromise: Promise<void> | null = null;
let resolveConnect: (() => void) | null = null;

const CONNECT_TIMEOUT_MS = 10_000;

/** Open the shell's WebSocket unless it is open or opening; after a drop it reopens on its own. */
export function initShellClient(): void {
  if (ws) {
    return; // Already initialized
  }
  closedByUs = false;

  const protocol = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Host only (host:port) — never the path, so deep-link reloads connect the same.
  ws = new WebSocket(`${protocol}//${globalThis.location.host}/__shell`);

  ws.onopen = () => {
    console.log('[ShellClient] Connected');
    shellClientConnected.value = true;
    resolveConnect?.();
    shellClientEpoch.value++;
  };

  ws.onclose = (event) => {
    console.log('[ShellClient] Disconnected');
    shellClientConnected.value = false;
    ws = null;
    connectPromise = null;
    resolveConnect = null;

    for (const [id, pending] of pendingRequests) {
      pending.reject(new Error('connection closed'));
      pendingRequests.delete(id);
    }

    // Follow streams and node subscriptions die with the socket; their ids were
    // minted by the server for this connection. Subscribers re-subscribe off
    // shellClientEpoch.
    subscriptionHandlers.clear();

    // The cookie names an ended session. Loading the page again is what gets
    // the browser a new, guest one; a reconnect would carry the old cookie.
    if (event.code === SESSION_ENDED_CLOSE_CODE) {
      globalThis.location.reload();
      return;
    }

    // Views are event-driven rather than polled, so a dead socket is a frozen
    // UI with nothing to notice it — reconnect rather than waiting for a reload.
    if (!closedByUs && reconnectTimer === null) {
      reconnectTimer = globalThis.setTimeout(() => {
        reconnectTimer = null;
        initShellClient();
      }, RECONNECT_DELAY_MS);
    }
  };

  ws.onerror = (error) => {
    console.error('[ShellClient] Error:', error);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === 'event' && msg.subscriptionId) {
        subscriptionHandlers.get(msg.subscriptionId)?.(msg.event);
        return;
      }

      const pending = pendingRequests.get(msg.id);

      if (pending) {
        pendingRequests.delete(msg.id);

        if (msg.type === 'result') {
          pending.resolve(msg.data);
        } else if (msg.type === 'error') {
          pending.reject(
            new ExecError(
              msg.message || 'Command failed',
              typeof msg.exitCode === 'number' ? msg.exitCode : undefined,
              typeof msg.output === 'string' ? msg.output : undefined,
              typeof msg.stderr === 'string' ? msg.stderr : undefined,
            ),
          );
        }
      }
    } catch (err) {
      console.error('[ShellClient] Failed to parse message:', err);
    }
  };
}

/** A command that exited non-zero: its message, and the exit code, stdout so far and stderr when the server sent them. */
export class ExecError extends Error {
  constructor(message: string, readonly exitCode?: number, readonly output?: string, readonly stderr?: string) {
    super(message);
    this.name = 'ExecError';
  }
}

/**
 * Resolve once the socket is OPEN, connecting if needed. Rejects if the
 * connection cannot be established within CONNECT_TIMEOUT_MS.
 */
function ensureConnected(): Promise<void> {
  if (ws && ws.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  if (!connectPromise) {
    connectPromise = new Promise<void>((resolve) => {
      resolveConnect = resolve;
    });
  }

  // Idempotent — starts the socket if it isn't already connecting.
  initShellClient();

  return Promise.race([
    connectPromise,
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('shell client connection timeout')), CONNECT_TIMEOUT_MS)),
  ]);
}

const abortError = (): Error => new DOMException('request aborted', 'AbortError');

/**
 * Send one request and wait for its answer. With `cancel`, aborting `signal` rejects at once and
 * sends the message `cancel` builds from the request's id; the answer that still comes for that id
 * finds no one waiting.
 */
function sendRequest<T>(
  payload: Record<string, unknown>,
  abort?: { signal?: AbortSignal; cancel: (id: string) => Record<string, unknown> },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('shell client not connected'));
      return;
    }
    const signal = abort?.signal;
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const id = `req-${++requestId}`;
    const onAbort = () => {
      if (!pendingRequests.delete(id)) return;
      reject(abortError());
      sendRequest(abort!.cancel(id)).catch(() => {
        // socket already closed — the server hangs up its commands on disconnect
      });
    };
    pendingRequests.set(id, {
      resolve: (value) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(value as T);
      },
      reject: (error) => {
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      },
    });
    signal?.addEventListener('abort', onAbort, { once: true });

    ws.send(JSON.stringify({ ...payload, id }));
  });
}

/**
 * Execute a shell command and return the result
 * @param command The command to execute
 * @param opts.signal Aborting it hangs the command up on the server and rejects with an `AbortError`
 * @returns Promise resolving to the command output (parsed as JSON)
 */
export async function execCommand<T>(command: string, opts: { signal?: AbortSignal } = {}): Promise<T> {
  await ensureConnected();

  return sendRequest<T>({ type: 'exec', command }, { signal: opts.signal, cancel: (id) => ({ type: 'exec.cancel', params: [id] }) });
}

/**
 * Run a script as a person would in a terminal: no `JSON_OUTPUT`, stdout back as text. For
 * the chat's approval card, whose output is read, not parsed.
 */
export async function execScript(script: string): Promise<string> {
  await ensureConnected();

  const data = await sendRequest<unknown>({ type: 'exec', command: script, json: false });
  return typeof data === 'string' ? data : data === null || data === undefined ? '' : JSON.stringify(data);
}

/** Filter accepted by `subscribeNodes` — mirrors the VFS EventSubscriptionFilter. */
export type NodeEventFilter = {
  eventTypes?: ('created' | 'updated' | 'deleted' | 'moved')[];
  pathPrefix?: string;
  recursive?: boolean;
  nodeTypes?: string[];
};

/** A VFS event as pushed over the socket. Carries the node's attrs. */
export type NodeEventMessage = {
  id: string;
  type: string;
  path: string;
  nodeId: string;
  nodeType: string;
  timestamp: number;
  node?: { attrs?: Record<string, unknown> };
};

/**
 * Subscribe to VFS node events, pushed by the server as they happen: the full NodeEvent,
 * attrs included and access-checked.
 *
 * The returned unsubscribe is safe to call after the socket has dropped. Note a
 * subscription does **not** survive a reconnect: watch `shellClientEpoch` and
 * re-subscribe (useNodeEvents does this).
 */
export async function subscribeNodes(
  filter: NodeEventFilter,
  onEvent: (event: NodeEventMessage) => void,
): Promise<() => void> {
  await ensureConnected();

  const { subscriptionId } = await sendRequest<{ subscriptionId: string }>({
    type: 'vfs.subscribe',
    params: [filter],
  });

  subscriptionHandlers.set(subscriptionId, (event) => onEvent(event as NodeEventMessage));

  return () => {
    subscriptionHandlers.delete(subscriptionId);
    sendRequest({ type: 'vfs.unsubscribe', params: [subscriptionId] }).catch(() => {
      // socket already closed — the server drops subscriptions on disconnect
    });
  };
}

/** A log entry pushed by a log.follow stream. */
export type LogFollowEntry = {
  id: number;
  createdAt: string;
  data: unknown;
};

/**
 * Tail a log node: the server streams existing entries and then live
 * appends (blocking reads, no polling). Returns an unfollow function.
 *
 * Pass `tail` unless you genuinely want the whole log — without it the server
 * starts at the first entry ever written and replays everything before reaching
 * live, which on /var/logs/system is a very long flood on every subscribe.
 */
export async function followLog(
  path: string,
  onEntries: (entries: LogFollowEntry[]) => void,
  opts?: { tail?: number },
): Promise<() => void> {
  await ensureConnected();

  const { subscriptionId } = await sendRequest<{ subscriptionId: string }>({
    type: 'log.follow',
    params: [path, opts ?? {}],
  });

  subscriptionHandlers.set(subscriptionId, (event) => {
    const entries = (event as { entries?: LogFollowEntry[] } | null)?.entries;
    if (entries && entries.length > 0) onEntries(entries);
  });

  return () => {
    subscriptionHandlers.delete(subscriptionId);
    sendRequest({ type: 'log.unfollow', params: [subscriptionId] }).catch(() => {
      // socket already closed — server cleans up on disconnect
    });
  };
}
