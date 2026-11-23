import { signal } from '@preact/signals-react';
import { saveAnswer, savedAnswer } from '../lib/saved-answers.ts';

/**
 * Shell client connection status
 */
export const shellClientConnected = signal(false);

/**
 * Whether EiN is out of reach: the socket closed without opening, or has not opened within
 * `UNREACHABLE_AFTER_MS`. While it is, a command is answered at once from what this device kept
 * (`execCommand`) instead of waiting for a connection; the socket keeps trying, and opening ends it.
 */
export const shellUnreachable = signal(typeof navigator !== 'undefined' && navigator.onLine === false);

/**
 * The oldest kept answer the page shows, by when it was read, and the path it was shown on: what the
 * header says the page's age is while EiN is out of reach. Null while every answer is EiN's own.
 */
export const savedAnswerShown = signal<{ path: string; at: number } | null>(null);

/**
 * Bumped every time the socket comes back up. Views that hold server-derived
 * state watch this to resync: a reconnect means new subscription ids and an
 * unknown amount of missed traffic, so whatever they were showing is stale.
 */
export const shellClientEpoch = signal(0);

let ws: WebSocket | null = null;
let requestId = 0;
/** An answer as it came: its data, whether the server marked it a read, and its size on the wire. */
type Answer = { data: unknown; read: boolean; size: number };
const pendingRequests = new Map<string, {
  resolve: (answer: Answer) => void;
  reject: (error: Error) => void;
}>();
// Push-event subscribers (log.follow streams, vfs.subscribe), keyed by server
// subscriptionId. Cleared on close — the ids belong to that socket.
const subscriptionHandlers = new Map<string, (event: unknown) => void>();

let reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
let unreachableTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
let closedByUs = false;
const RECONNECT_DELAY_MS = 2000;
/** How long a socket may take to open before EiN counts as out of reach. */
const UNREACHABLE_AFTER_MS = 5000;
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
  watchNetwork();

  const protocol = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Host only (host:port) — never the path, so deep-link reloads connect the same.
  ws = new WebSocket(`${protocol}//${globalThis.location.host}/__shell`);
  let opened = false;
  unreachableTimer ??= globalThis.setTimeout(() => {
    unreachableTimer = null;
    shellUnreachable.value = true;
  }, UNREACHABLE_AFTER_MS);

  ws.onopen = () => {
    console.log('[ShellClient] Connected');
    opened = true;
    stopUnreachableTimer();
    shellUnreachable.value = false;
    shellClientConnected.value = true;
    resolveConnect?.();
    shellClientEpoch.value++;
  };

  ws.onclose = (event) => {
    console.log('[ShellClient] Disconnected');
    if (!opened) {
      stopUnreachableTimer();
      shellUnreachable.value = true;
    }
    shellClientConnected.value = false;
    ws = null;
    connectPromise = null;
    resolveConnect = null;

    for (const [id, pending] of pendingRequests) {
      pending.reject(new ShellUnreachableError('connection closed'));
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
          pending.resolve({ data: msg.data, read: msg.read === true, size: event.data.length });
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

const stopUnreachableTimer = (): void => {
  if (unreachableTimer === null) return;
  globalThis.clearTimeout(unreachableTimer);
  unreachableTimer = null;
};

let watchingNetwork = false;

/**
 * Try the socket again as soon as the browser says the network is back, rather than at the next
 * retry; and take its word that the network is gone.
 */
function watchNetwork(): void {
  if (watchingNetwork) return;
  watchingNetwork = true;
  globalThis.addEventListener('online', () => reconnectNow());
  globalThis.addEventListener('offline', () => {
    if (!shellClientConnected.peek()) shellUnreachable.value = true;
  });
}

/** Open the socket now if it is down and waiting to retry. */
export function reconnectNow(): void {
  if (ws || closedByUs) return;
  if (reconnectTimer !== null) {
    globalThis.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  initShellClient();
}

/** The shell's socket is not there to ask: down, closed under the request, or not opening. */
export class ShellUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShellUnreachableError';
  }
}

/** EiN is out of reach and this device kept no answer to the command. */
export class OfflineError extends Error {
  constructor() {
    super('offline: EiN is out of reach, and this was not saved on this device');
    this.name = 'OfflineError';
  }
}

/** A command that exited non-zero: its message, and the exit code, stdout so far and stderr when the server sent them. */
export class ExecError extends Error {
  constructor(message: string, readonly exitCode?: number, readonly output?: string, readonly stderr?: string) {
    super(message);
    this.name = 'ExecError';
  }
}

/**
 * Resolve once the socket is OPEN, connecting if needed. Rejects if the connection cannot be
 * established within CONNECT_TIMEOUT_MS, or as soon as EiN counts as out of reach.
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

  const connecting = connectPromise;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let stopWatching = () => {};
  return new Promise<void>((resolve, reject) => {
    timer = globalThis.setTimeout(() => reject(new ShellUnreachableError('shell client connection timeout')), CONNECT_TIMEOUT_MS);
    stopWatching = shellUnreachable.subscribe((unreachable) => {
      if (unreachable) reject(new ShellUnreachableError('EiN is out of reach'));
    });
    void connecting.then(resolve);
  }).finally(() => {
    globalThis.clearTimeout(timer);
    stopWatching();
  });
}

const abortError = (): Error => new DOMException('request aborted', 'AbortError');

/**
 * Send one request and wait for its answer. With `cancel`, aborting `signal` rejects at once and
 * sends the message `cancel` builds from the request's id; the answer that still comes for that id
 * finds no one waiting.
 */
function request(
  payload: Record<string, unknown>,
  abort?: { signal?: AbortSignal; cancel: (id: string) => Record<string, unknown> },
): Promise<Answer> {
  return new Promise<Answer>((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new ShellUnreachableError('shell client not connected'));
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
      request(abort!.cancel(id)).catch(() => {
        // socket already closed — the server hangs up its commands on disconnect
      });
    };
    pendingRequests.set(id, {
      resolve: (answer) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(answer);
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

/** `request`, for its data alone. */
const sendRequest = async <T>(payload: Record<string, unknown>): Promise<T> => (await request(payload)).data as T;

/**
 * Execute a shell command and return the result
 *
 * An answer the server marks a read is kept on this device (`lib/saved-answers.ts`). While EiN is
 * out of reach (`shellUnreachable`), or when the socket fails under the request, the kept answer is
 * given instead, and `savedAnswerShown` says how old it is; a command with none, which every write
 * is, fails with an `OfflineError`.
 *
 * @param command The command to execute
 * @param opts.signal Aborting it hangs the command up on the server and rejects with an `AbortError`
 * @param opts.stdin What the command reads as its stdin: text it takes as `-` (`comment add <path> --body -`); such a command is never kept
 * @returns Promise resolving to the command output (parsed as JSON)
 */
export async function execCommand<T>(command: string, opts: { signal?: AbortSignal; stdin?: string } = {}): Promise<T> {
  return await exec<T>(command, opts, true);
}

/**
 * `execCommand` for what is no part of what a page shows, an icon or the frame's own state: a kept
 * answer it is given is not counted in the page's age (`savedAnswerShown`).
 */
export async function execFrameCommand<T>(command: string, opts: { signal?: AbortSignal } = {}): Promise<T> {
  return await exec<T>(command, opts, false);
}

const exec = async <T>(command: string, opts: { signal?: AbortSignal; stdin?: string }, aged: boolean): Promise<T> => {
  if (!shellUnreachable.peek()) {
    try {
      await ensureConnected();
      const answer = await request(
        { type: 'exec', command, ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}) },
        { signal: opts.signal, cancel: (id) => ({ type: 'exec.cancel', params: [id] }) },
      );
      if (answer.read && opts.stdin === undefined) saveAnswer(command, answer.data, answer.size);
      return answer.data as T;
    } catch (error) {
      if (!(error instanceof ShellUnreachableError)) throw error;
    }
  }
  const saved = opts.stdin === undefined ? await savedAnswer(command) : undefined;
  if (opts.signal?.aborted) throw abortError();
  if (!saved) throw new OfflineError();
  const path = globalThis.location.pathname;
  const shown = savedAnswerShown.peek();
  if (aged && (!shown || shown.path !== path || saved.at < shown.at)) savedAnswerShown.value = { path, at: saved.at };
  return saved.data as T;
};

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
