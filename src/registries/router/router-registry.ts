import { isRoutingPattern, routingPatternRegex } from '../routing-key-match.ts';
import { ensureResource, ResourceMode } from '../types.ts';
import { RouterHandle } from './router-handle.ts';
import type { RelayEventUnsubscriber } from '../../managers/router/mod.ts';
import { RouterRegistryConfig, RouterRegistryIf, RouterResourceOptions, RouterStat } from './types.ts';

type RouteEntry = {
  routingKey?: string;
};

/**
 * Split a written chunk into the JSON values it carries. Router nodes are JSONL
 * broadcasters, so a write of one or more newline-separated JSON objects becomes
 * one published payload per line. A line that is not JSON is published as-is
 * (plain text written to a router node is still a valid message).
 */
const decodePayloads = (data: Uint8Array): unknown[] => {
  const text = new TextDecoder().decode(data);
  const payloads: unknown[] = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    try {
      payloads.push(JSON.parse(trimmed));
    } catch {
      payloads.push(trimmed);
    }
  }

  return payloads;
};

/** Render a published payload back to a JSONL line for readers. */
const encodePayload = (payload: unknown): Uint8Array => {
  const line = typeof payload === 'string' ? payload : JSON.stringify(payload);

  return new TextEncoder().encode(`${line}\n`);
};

export class RouterRegistry implements RouterRegistryIf {
  private routes = new Map<string, RouteEntry>();
  private readers = new Map<string, Set<(data: Uint8Array) => void>>();
  /**
   * The reader keys that are patterns, compiled. Normally empty, and consulted only when it is
   * not: every message published anywhere in the instance reaches the relay handler, so the exact
   * key must stay a single map lookup there.
   */
  private patternReaders = new Map<string, RegExp>();
  private relayUnsubscribe?: RelayEventUnsubscriber;

  constructor(private config: RouterRegistryConfig) {}

  async init(): Promise<void> {
    // Readers of a routed node see everything published on its key, not just
    // what was written through the node itself — that is what makes
    // `cat /dev/events` a live tail of the routing key.
    this.relayUnsubscribe = this.config.router.on(async (routingKey, payload) => {
      // Every published message on every key lands here, so cost must be a map
      // lookup — only serialise once a reader is actually waiting.
      const exact = this.readers.get(routingKey);
      const matched = this.matchingPatternReaders(routingKey);

      if (!exact && matched.length === 0) {
        return;
      }

      const data = encodePayload(payload);

      if (exact) {
        this.wake(exact, data);
      }

      for (const waiters of matched) {
        this.wake(waiters, data);
      }
    });
  }

  async dispose(): Promise<void> {
    if (this.relayUnsubscribe) {
      this.relayUnsubscribe();
      this.relayUnsubscribe = undefined;
    }

    for (const waiters of this.readers.values()) {
      for (const resolve of waiters) {
        resolve(new Uint8Array(0));
      }
    }

    this.routes.clear();
    this.readers.clear();
    this.patternReaders.clear();
  }

  /** Hand `data` to every reader waiting on `key`. */
  private deliver(key: string, data: Uint8Array): void {
    const waiters = this.readers.get(key);

    if (!waiters) {
      return;
    }

    this.wake(waiters, data);
  }

  /** Resolve one set of waiting reads. Each waiter removes itself as it resolves. */
  private wake(waiters: Set<(data: Uint8Array) => void>, data: Uint8Array): void {
    for (const resolve of waiters) {
      resolve(data);
    }
  }

  /** The reader sets whose pattern covers `routingKey`. Empty unless a pattern node is being read. */
  private matchingPatternReaders(routingKey: string): Set<(data: Uint8Array) => void>[] {
    if (this.patternReaders.size === 0) {
      return [];
    }

    const matched: Set<(data: Uint8Array) => void>[] = [];

    for (const [key, regex] of this.patternReaders) {
      if (!regex.test(routingKey)) {
        continue;
      }

      const waiters = this.readers.get(key);

      if (waiters) {
        matched.push(waiters);
      }
    }

    return matched;
  }

  /**
   * Register one waiting read, returning its removal.
   *
   * `pattern` is passed rather than derived from the key because a node without a routing key reads
   * under its own id, which must never be interpreted as a pattern.
   */
  private addReader(key: string, pattern: boolean, onData: (data: Uint8Array) => void): () => void {
    let waiters = this.readers.get(key);

    if (!waiters) {
      waiters = new Set();
      this.readers.set(key, waiters);

      if (pattern) {
        this.patternReaders.set(key, routingPatternRegex(key));
      }
    }

    waiters.add(onData);

    return () => {
      waiters.delete(onData);

      // The identity check keeps a late removal from evicting a *newer* set registered under the
      // same key after this one was dropped — which would silently orphan live readers.
      if (waiters.size === 0 && this.readers.get(key) === waiters) {
        this.readers.delete(key);
        this.patternReaders.delete(key);
      }
    };
  }

  async touch(id: string, opts: RouterResourceOptions): Promise<boolean> {
    const existing = this.routes.get(id);

    if (existing) {
      if (existing.routingKey === opts.routingKey) {
        return false;
      }

      existing.routingKey = opts.routingKey;

      return true;
    }

    this.routes.set(id, { routingKey: opts.routingKey });

    return true;
  }

  async open(id: string, opts: RouterResourceOptions, mode?: ResourceMode): Promise<RouterHandle> {
    await ensureResource(this, id, opts, mode);

    const entry = this.routes.get(id)!;

    // Readers of a node without a routing key are local to that node; readers of
    // a routed node see everything published on its key.
    const readerKey = entry.routingKey ?? id;

    // A pattern key breaks the node's usual symmetry: it says which keys to tail, and there is no
    // single key it could publish on, so the node is a read-only view.
    const pattern = entry.routingKey !== undefined && isRoutingPattern(entry.routingKey);

    const onWrite = async (data: Uint8Array): Promise<void> => {
      // A node without a routing key has nothing to route to: its readers are
      // fed here. Readers of a routed node are fed by the relay subscription in
      // init(), so they see other publishers on the key too.
      if (!entry.routingKey) {
        this.deliver(readerKey, data);

        return;
      }

      if (pattern) {
        throw new Error(`cannot publish to a routing key pattern: ${entry.routingKey}`);
      }

      for (const payload of decodePayloads(data)) {
        this.config.router.publish(entry.routingKey, payload);
      }
    };

    const onRead = (signal?: AbortSignal): Promise<Uint8Array> => {
      return new Promise<Uint8Array>((resolve) => {
        if (signal?.aborted) {
          resolve(new Uint8Array(0));
          return;
        }

        const onData = (data: Uint8Array) => {
          cleanup();
          resolve(data);
        };

        const onAbort = () => {
          cleanup();
          resolve(new Uint8Array(0));
        };

        const removeReader = this.addReader(readerKey, pattern, onData);

        const cleanup = () => {
          removeReader();
          signal?.removeEventListener('abort', onAbort);
        };

        signal?.addEventListener('abort', onAbort, { once: true });
      });
    };

    const handle = new RouterHandle(id, opts, mode || 'r', this, onWrite, onRead);
    await handle.init();

    return handle;
  }

  async exists(id: string): Promise<boolean> {
    return this.routes.has(id);
  }

  async stat(id: string): Promise<RouterStat> {
    const entry = this.routes.get(id);

    if (!entry) {
      throw new Error(`route not found: ${id}`);
    }

    const waiters = this.readers.get(entry.routingKey ?? id);

    return {
      routingKey: entry.routingKey,
      subscribers: waiters?.size ?? 0,
    };
  }

  async statX(id: string): Promise<RouterStat> {
    return await this.stat(id);
  }

  async delete(id: string): Promise<boolean> {
    return this.routes.delete(id);
  }

  async list(_id?: string): Promise<AsyncIterable<string>> {
    const keys = Array.from(this.routes.keys());

    return (async function* () {
      for (const key of keys) {
        yield key;
      }
    })();
  }

  async count(_id?: string): Promise<number> {
    return this.routes.size;
  }

  publish(routingKey: string, payload: unknown): void {
    this.config.router.publish(routingKey, payload);
  }
}
