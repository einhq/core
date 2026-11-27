import { AbstractResourceHandle, type RegistryIf, type ResourceHandleIf, type ResourceMode } from '../types.ts';
import { SOCKET_BACKLOG, SOCKET_BUFFER, type SocketConnection, type SocketListener, type SocketPeer, type SocketResourceOptions } from './types.ts';

/**
 * A socket's registry: one listener and its connections, kept in this process's memory and nowhere
 * else. Opening a socket to read makes the listener, while nobody else listens; opening it in a mode
 * that writes connects to that listener, and is refused while nobody listens or while
 * `SOCKET_BACKLOG` connections wait to be accepted. A connection is two ends, the client's and the
 * one the listener accepts, each holding the messages the other wrote that it has not read yet, up to
 * `SOCKET_BUFFER`; past it the connection is let go, so neither end ever waits for the other. What a
 * client writes before it is accepted waits in its connection.
 */
export class SocketRegistry implements RegistryIf<SocketResourceOptions> {
  readonly #listeners = new Map<string, SocketListenerHandle>();

  constructor(private readonly options: { buffer?: number; backlog?: number } = {}) {}

  async init(): Promise<void> {}

  async dispose(): Promise<void> {
    for (const id of [...this.#listeners.keys()]) await this.delete(id);
  }

  async touch(_id: string, _opts: SocketResourceOptions): Promise<boolean> {
    return false;
  }

  /** `r` listens; a mode that writes connects as `opts.peer`, which the VFS sets to whoever opens it. */
  async open(id: string, opts: SocketResourceOptions, mode: ResourceMode = 'r'): Promise<ResourceHandleIf<SocketResourceOptions>> {
    if (mode === 'r') {
      if (this.#listeners.has(id)) throw new Error('the socket has a listener already');
      const listener: SocketListenerHandle = new SocketListenerHandle(id, opts, this, this.options.backlog ?? SOCKET_BACKLOG, this.options.buffer ?? SOCKET_BUFFER, () => {
        if (this.#listeners.get(id) === listener) this.#listeners.delete(id);
      });
      this.#listeners.set(id, listener);
      return listener;
    }
    const listener = this.#listeners.get(id);
    if (!listener) throw new Error('nobody listens on the socket');
    if (!opts.peer) throw new Error('a connection to a socket needs whoever connects');
    return listener.connect(opts.peer);
  }

  async exists(_id: string): Promise<boolean> {
    return true;
  }

  /** A socket holds nothing, so its size is 0; `listening` says whether anyone listens, `connections` how many it has, accepted or waiting. */
  async stat(id: string): Promise<Record<string, unknown>> {
    const listener = this.#listeners.get(id);
    return { size: 0, listening: Boolean(listener), connections: listener?.connections ?? 0 };
  }

  async statX(id: string): Promise<Record<string, unknown>> {
    return await this.stat(id);
  }

  /** The socket's node is gone: its listener and every connection are closed. */
  async delete(id: string): Promise<boolean> {
    const listener = this.#listeners.get(id);
    if (!listener) return false;
    await listener.close();
    return true;
  }

  async list(_id?: string): Promise<AsyncIterable<string>> {
    const ids = [...this.#listeners.keys()];
    return (async function* () {
      yield* ids;
    })();
  }

  async count(_id?: string): Promise<number> {
    return this.#listeners.size;
  }
}

class SocketListenerHandle extends AbstractResourceHandle<SocketResourceOptions> implements SocketListener {
  /** The listener's ends of the connections not accepted yet, oldest first. */
  #waiting: ConnectionEnd[] = [];
  readonly #connections = new Set<Connection>();
  #arrived?: PromiseWithResolvers<void>;

  constructor(
    id: string,
    options: SocketResourceOptions,
    registry: RegistryIf<SocketResourceOptions>,
    private readonly backlog: number,
    private readonly buffer: number,
    private readonly gone: () => void,
  ) {
    super(id, options, 'r', registry);
  }

  get connections(): number {
    return this.#connections.size;
  }

  /** A new connection from `peer`: the client's end, while the listener's waits to be accepted. */
  connect(peer: SocketPeer): ConnectionEnd {
    this.assertNotClosed();
    if (this.#waiting.length >= this.backlog) throw new Error('the socket has too many connections waiting');
    const connection: Connection = new Connection(this.id, this.options, this.registry, peer, this.buffer, () => {
      this.#connections.delete(connection);
      this.#waiting = this.#waiting.filter((end) => end !== connection.listening);
    });
    this.#connections.add(connection);
    this.#waiting.push(connection.listening);
    this.#arrived?.resolve();
    return connection.client;
  }

  async accept(signal?: AbortSignal): Promise<SocketConnection | undefined> {
    for (;;) {
      if (this._closed) return undefined;
      const next = this.#waiting.shift();
      if (next) return next;
      signal?.throwIfAborted();
      const arrived = this.#arrived = Promise.withResolvers<void>();
      const closed = () => arrived.resolve();
      const abort = () => arrived.reject(signal?.reason);
      this.signal.addEventListener('abort', closed, { once: true });
      signal?.addEventListener('abort', abort, { once: true });
      try {
        await arrived.promise;
      } finally {
        this.signal.removeEventListener('abort', closed);
        signal?.removeEventListener('abort', abort);
        if (this.#arrived === arrived) this.#arrived = undefined;
      }
    }
  }

  async read(_size: number | bigint, _signal?: AbortSignal): Promise<Uint8Array> {
    throw new Error("a socket's listener accepts connections; it reads none itself");
  }

  async write(_data: Uint8Array): Promise<number> {
    throw new Error("a socket's listener accepts connections; it writes none itself");
  }

  override async close(): Promise<void> {
    if (this._closed) return;
    await super.close();
    for (const connection of [...this.#connections]) connection.end();
    this.#waiting = [];
    this.gone();
  }
}

/** A connection while it lasts: its client's end, the listener's end, and whether it was let go for falling behind. */
class Connection {
  readonly client: ConnectionEnd;
  readonly listening: ConnectionEnd;
  #ended = false;
  behind = false;

  constructor(
    id: string,
    options: SocketResourceOptions,
    registry: RegistryIf<SocketResourceOptions>,
    readonly peer: SocketPeer,
    limit: number,
    private readonly done: () => void,
  ) {
    this.client = new ConnectionEnd(id, options, registry, this, limit);
    this.listening = new ConnectionEnd(id, options, registry, this, limit);
  }

  get ended(): boolean {
    return this.#ended;
  }

  other(end: ConnectionEnd): ConnectionEnd {
    return end === this.client ? this.listening : this.client;
  }

  /** No more goes either way: each end reads what it holds, and then its end. */
  end(behind = false): void {
    if (this.#ended) return;
    this.#ended = true;
    this.behind = behind;
    this.client.finish();
    this.listening.finish();
    this.done();
  }
}

class ConnectionEnd extends AbstractResourceHandle<SocketResourceOptions> implements SocketConnection {
  #messages: Uint8Array[] = [];
  #held = 0;
  #finished = false;
  #waiting?: PromiseWithResolvers<void>;

  constructor(
    id: string,
    options: SocketResourceOptions,
    registry: RegistryIf<SocketResourceOptions>,
    private readonly connection: Connection,
    private readonly limit: number,
  ) {
    super(id, options, 'r+', registry);
  }

  get peer(): SocketPeer {
    return this.connection.peer;
  }

  get behind(): boolean {
    return this.connection.behind;
  }

  /** A message from the other end; one that would put this end past its limit lets the connection go. */
  push(data: Uint8Array): void {
    if (this.#finished) return;
    if (this.#held + data.length > this.limit) return this.connection.end(true);
    this.#messages.push(data);
    this.#held += data.length;
    this.#waiting?.resolve();
  }

  /** No more comes: what it holds is read, and then its end. */
  finish(): void {
    this.#finished = true;
    this.#waiting?.resolve();
  }

  async read(size: number | bigint, signal?: AbortSignal): Promise<Uint8Array> {
    this.assertNotClosed();
    const want = Math.max(1, Number(size));
    while (this.#messages.length === 0) {
      if (this.#finished) return new Uint8Array(0);
      signal?.throwIfAborted();
      this.signal.throwIfAborted();
      const waiting = this.#waiting = Promise.withResolvers<void>();
      const abort = () => waiting.reject(signal?.reason ?? this.signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      this.signal.addEventListener('abort', abort, { once: true });
      try {
        await waiting.promise;
      } finally {
        signal?.removeEventListener('abort', abort);
        this.signal.removeEventListener('abort', abort);
        if (this.#waiting === waiting) this.#waiting = undefined;
      }
    }
    // A message is this end's alone, so a whole one is answered as it is, for the caller to keep.
    const first = this.#messages[0];
    if (first.length <= want) {
      this.#messages.shift();
      this.#held -= first.length;
      return first;
    }
    this.#messages[0] = first.subarray(want);
    this.#held -= want;
    return first.slice(0, want);
  }

  /** `data` as one message to the other end; an empty one sends nothing. */
  async write(data: Uint8Array): Promise<number> {
    this.assertNotClosed();
    if (this.connection.ended) throw new Error('the connection has ended');
    // A copy: the caller may reuse its buffer once the write returns.
    if (data.length > 0) this.connection.other(this).push(data.slice());
    return data.length;
  }

  override async close(): Promise<void> {
    if (this._closed) return;
    await super.close();
    this.#messages = [];
    this.#held = 0;
    this.connection.end();
  }
}
