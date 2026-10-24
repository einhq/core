import type { RelayEventConsumer, RelayEventUnsubscriber, RouterManagerIf } from './types.ts';

type QueuedMessage = {
  routingKey: string;
  payload: unknown;
};

export class RouterManager implements RouterManagerIf {
  private consumers = new Set<RelayEventConsumer>();
  private startupQueue: QueuedMessage[] = [];
  private released = false;
  private decoder = new TextDecoder();
  /** Fanout timers scheduled but not yet fired — see `fanout` and `dispose`. */
  private pending = new Set<ReturnType<typeof setTimeout>>();

  async init(): Promise<void> {}

  async dispose(): Promise<void> {
    // Deferred fanout captures its consumer, so clearing the set does not stop a delivery
    // already in the timer queue: it would still call a consumer whose registry has been
    // disposed. Cancelling also settles the timers, which a test's leak sanitizer counts.
    for (const timer of this.pending) clearTimeout(timer);
    this.pending.clear();
    this.startupQueue = [];
    this.consumers.clear();
  }

  publish(routingKey: string, payload: unknown): void {
    if (!this.released) {
      this.startupQueue.push({ routingKey, payload });
      return;
    }

    this.fanout(routingKey, payload);
  }

  on(handler: RelayEventConsumer): RelayEventUnsubscriber {
    this.consumers.add(handler);

    return () => {
      this.consumers.delete(handler);
    };
  }

  release(): void {
    if (this.released) return;

    this.released = true;

    const queued = this.startupQueue;
    this.startupQueue = [];

    for (const { routingKey, payload } of queued) {
      this.fanout(routingKey, payload);
    }
  }

  private fanout(routingKey: string, payload: unknown): void {
    if (this.consumers.size === 0) return;

    let decoded: unknown = payload;

    if (payload instanceof Uint8Array) {
      const text = this.decoder.decode(payload).trim();

      try {
        decoded = JSON.parse(text);
      } catch {
        decoded = text;
      }
    }

    for (const consumer of this.consumers) {
      // Delivery is a macrotask: a consumer that logs while handling an entry publishes again,
      // and as microtasks that cycle would never yield to I/O.
      const key = routingKey;
      const data = decoded;
      const timer = setTimeout(() => {
        this.pending.delete(timer);
        consumer(key, data).catch(() => {});
      }, 0);
      this.pending.add(timer);
    }
  }
}
