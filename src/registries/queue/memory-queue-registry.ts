import type { RelayEventUnsubscriber } from '../../managers/router/mod.ts';
import { routingKeysMatch } from '../routing-key-match.ts';
import { ensureResource, ResourceMode } from '../types.ts';
import { QueueHandle } from './queue-handle.ts';
import { createLogger } from '../../managers/logger/mod.ts';
import {
  QUEUE_DEFAULT_LEASE_MS,
  QUEUE_DEFAULT_MAX_ATTEMPTS,
  QueueDeadAction,
  QueueDeadEntry,
  QueueEntry,
  QueueEntryId,
  QueueIO,
  QueuePeekEntry,
  QueueRegistryConfig,
  QueueRegistryIf,
  QueueResourceOptions,
  QueueStat,
} from './types.ts';

const logger = createLogger('memory-queue-registry');

type Subscription = {
  routingKeys: string[];
  createdAt: Date;
};

type Message = {
  id: number;
  routingKey: string;
  payload: unknown;
  createdAt: Date;
};

type Delivery = {
  id: number;
  subscriptionId: string;
  messageId: number;
  lockedAt: Date | null;
  /** Deliveries handed out so far; the dead-letter threshold counts these. */
  attempts: number;
  /** Set once the entry gave up its last attempt. Never claimable again. */
  deadAt: Date | null;
};

export class MemoryQueueRegistry implements QueueRegistryIf {
  private initialized = false;
  private subscriptions = new Map<string, Subscription>();
  private messages = new Map<number, Message>();
  private deliveries = new Map<number, Delivery>();
  private nextMessageId = 1;
  private nextDeliveryId = 1;
  private listeners = new Map<string, Set<() => void>>();
  private relayUnsubscribe: RelayEventUnsubscriber | undefined;

  constructor(private config: QueueRegistryConfig) {}

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.relayUnsubscribe = this.config.router.on(async (routingKey: string, payload: unknown) => {
      await this.handleRelayEvent(routingKey, payload);
    });

    this.initialized = true;
  }

  async dispose(): Promise<void> {
    if (this.relayUnsubscribe) {
      this.relayUnsubscribe();
      this.relayUnsubscribe = undefined;
    }

    for (const set of this.listeners.values()) {
      for (const cb of set) cb();
    }

    this.subscriptions.clear();
    this.messages.clear();
    this.deliveries.clear();
    this.listeners.clear();
  }

  async touch(id: string, opts: QueueResourceOptions): Promise<boolean> {
    const routingKeys = opts.routingKeys ?? [];

    const existing = this.subscriptions.get(id);

    if (existing) {
      if (arraysEqual(existing.routingKeys, routingKeys)) {
        return false;
      }

      existing.routingKeys = routingKeys;
      return true;
    }

    this.subscriptions.set(id, { routingKeys, createdAt: new Date() });
    return true;
  }

  async open(id: string, opts: QueueResourceOptions, mode?: ResourceMode): Promise<QueueHandle> {
    const { truncate } = await ensureResource(this, id, opts, mode);

    if (truncate) {
      this.truncate(id);
    }

    const io: QueueIO = {
      append: async (data: unknown): Promise<QueueEntryId> => {
        return this.append(id, data);
      },
      read: async (signal?: AbortSignal): Promise<QueueEntry | null> => {
        return this.read(id, opts.leaseMs ?? QUEUE_DEFAULT_LEASE_MS, opts.maxAttempts ?? QUEUE_DEFAULT_MAX_ATTEMPTS, signal);
      },
      ack: async (entryId: QueueEntryId): Promise<void> => {
        this.ack(entryId);
      },
      nack: async (entryId: QueueEntryId): Promise<void> => {
        this.nack(id, entryId, opts.maxAttempts ?? QUEUE_DEFAULT_MAX_ATTEMPTS);
      },
    };

    const rh = new QueueHandle(id, opts, mode || 'r', this, io);
    await rh.init();

    return rh;
  }

  async exists(id: string): Promise<boolean> {
    return this.subscriptions.has(id);
  }

  async peek(id: string, limit: number): Promise<QueuePeekEntry[]> {
    if (!this.subscriptions.has(id)) {
      throw new Error(`no queue found: ${id}`);
    }

    const live = [...this.deliveries.values()]
      .filter((d) => d.subscriptionId === id && d.deadAt === null)
      .sort((a, b) => a.id - b.id)
      .slice(0, Math.max(0, limit));

    return live.flatMap((d) => {
      const msg = this.messages.get(d.messageId);
      if (!msg) return [];
      return [{
        id: d.id,
        routingKey: msg.routingKey,
        data: msg.payload,
        createdAt: msg.createdAt,
        state: d.lockedAt === null ? 'ready' as const : 'in-flight' as const,
        attempts: d.attempts,
      }];
    });
  }

  async deadLetters(id: string, limit: number): Promise<QueueDeadEntry[]> {
    if (!this.subscriptions.has(id)) {
      throw new Error(`no queue found: ${id}`);
    }

    const dead = [...this.deliveries.values()]
      .filter((d) => d.subscriptionId === id && d.deadAt !== null)
      .sort((a, b) => a.id - b.id)
      .slice(0, Math.max(0, limit));

    return dead.flatMap((d) => {
      const msg = this.messages.get(d.messageId);
      if (!msg || d.deadAt === null) return [];
      return [{ id: d.id, routingKey: msg.routingKey, data: msg.payload, createdAt: msg.createdAt, attempts: d.attempts, deadAt: d.deadAt }];
    });
  }

  async settleDead(id: string, action: QueueDeadAction, ids?: QueueEntryId[]): Promise<number> {
    if (!this.subscriptions.has(id)) {
      throw new Error(`no queue found: ${id}`);
    }

    const only = ids ? new Set(ids) : undefined;
    let settled = 0;

    for (const [deliveryId, d] of this.deliveries) {
      if (d.subscriptionId !== id || d.deadAt === null || (only && !only.has(deliveryId))) continue;
      settled++;
      if (action === 'drop') {
        this.deliveries.delete(deliveryId);
      } else {
        d.deadAt = null;
        d.lockedAt = null;
        d.attempts = 0;
      }
    }

    if (action === 'drop') this.cleanOrphanMessages();
    else if (settled > 0) this.notifyListeners(id);
    return settled;
  }

  async stat(id: string): Promise<QueueStat> {
    const sub = this.subscriptions.get(id);

    if (!sub) {
      throw new Error(`no queue found: ${id}`);
    }

    let ready = 0;
    let inFlight = 0;
    let deadLettered = 0;
    let oldestLock = 0;

    for (const d of this.deliveries.values()) {
      if (d.subscriptionId !== id) continue;

      // Counted apart from both: a dead-lettered entry is neither backlog nor
      // work in progress, and folding it into either would make a wedged queue
      // read as a busy one.
      if (d.deadAt !== null) {
        deadLettered++;
      } else if (d.lockedAt === null) {
        ready++;
      } else {
        inFlight++;
        const at = d.lockedAt.getTime();
        if (oldestLock === 0 || at < oldestLock) oldestLock = at;
      }
    }

    return {
      size: ready,
      inFlight,
      oldestInFlightMs: oldestLock === 0 ? 0 : Math.max(0, Date.now() - oldestLock),
      deadLettered,
      routingKeys: sub.routingKeys,
    };
  }

  async statX(id: string): Promise<QueueStat> {
    return this.stat(id);
  }

  async delete(id: string): Promise<boolean> {
    if (!this.subscriptions.has(id)) {
      return false;
    }

    this.subscriptions.delete(id);
    this.deleteDeliveriesForSubscription(id);
    this.cleanOrphanMessages();

    const set = this.listeners.get(id);
    if (set) {
      for (const cb of set) cb();
      this.listeners.delete(id);
    }

    return true;
  }

  async list(): Promise<AsyncIterable<string>> {
    const keys = Array.from(this.subscriptions.keys());

    return (async function* () {
      for (const key of keys) {
        yield key;
      }
    })();
  }

  async count(_id?: string): Promise<number> {
    return this.subscriptions.size;
  }

  private handleRelayEvent(routingKey: string, payload: unknown): void {
    // Nothing is stored unless some subscription wants it.
    //
    // A message is only freed when a delivery referencing it is acked, so a message stored
    // with no delivery is never freed at all. Every event published anywhere in the instance
    // reaches this handler — all of `system.logs`, every VFS event — and a memory mount
    // (`/tmp`) usually has no queues bound to any of them, so storing first and matching
    // afterwards would retain the entire event stream of the process.
    const subscribers: string[] = [];

    for (const [subId, sub] of this.subscriptions) {
      if (routingKeysMatch(sub.routingKeys, routingKey)) subscribers.push(subId);
    }

    if (subscribers.length === 0) {
      return;
    }

    const msgId = this.nextMessageId++;
    this.messages.set(msgId, {
      id: msgId,
      routingKey,
      payload,
      createdAt: new Date(),
    });

    for (const subId of subscribers) {
      const delId = this.nextDeliveryId++;
      this.deliveries.set(delId, {
        id: delId,
        subscriptionId: subId,
        messageId: msgId,
        lockedAt: null,
        attempts: 0,
        deadAt: null,
      });
      this.notifyListeners(subId);
    }
  }

  private append(subscriptionId: string, data: unknown): QueueEntryId {
    const msgId = this.nextMessageId++;
    this.messages.set(msgId, {
      id: msgId,
      routingKey: '-',
      payload: data,
      createdAt: new Date(),
    });

    const delId = this.nextDeliveryId++;
    this.deliveries.set(delId, {
      id: delId,
      subscriptionId,
      messageId: msgId,
      lockedAt: null,
      attempts: 0,
      deadAt: null,
    });

    this.notifyListeners(subscriptionId);
    return delId;
  }

  /**
   * Hand back deliveries whose lease has run out.
   *
   * Mirrors the PostgreSQL sweep so both backends lose an entry under the same
   * conditions — which is to say, neither does: a consumer that dies holding an
   * entry gets it taken back rather than taking it with it.
   */
  private reclaimExpired(subscriptionId: string, leaseMs: number, maxAttempts: number): void {
    if (leaseMs <= 0) return;

    const cutoff = Date.now() - leaseMs;

    for (const d of this.deliveries.values()) {
      if (d.subscriptionId !== subscriptionId) continue;
      if (d.deadAt !== null) continue;
      if (d.lockedAt !== null && d.lockedAt.getTime() <= cutoff) {
        d.lockedAt = null;

        // The lease path has to spend the attempt too. A consumer that dies on
        // an entry never nacks it, so bounding only the nack would leave the
        // crash-loop half of the problem redelivering forever.
        if (maxAttempts > 0 && d.attempts >= maxAttempts) {
          d.deadAt = new Date();
          logger.error('dead-lettering queue entry after exhausted lease', {
            queue: subscriptionId,
            entry: d.id,
            attempts: d.attempts,
          });
        }
      }
    }
  }

  /** Lowest-id unlocked, not-yet-dead delivery for a subscription. */
  private findClaimable(subscriptionId: string): Delivery | null {
    let earliest: Delivery | null = null;

    for (const d of this.deliveries.values()) {
      if (d.subscriptionId !== subscriptionId || d.lockedAt !== null || d.deadAt !== null) continue;
      if (!earliest || d.id < earliest.id) earliest = d;
    }

    return earliest;
  }

  private tryLockNext(subscriptionId: string, leaseMs: number, maxAttempts: number): QueueEntry | null {
    let earliest = this.findClaimable(subscriptionId);

    // Only on a miss, matching the PostgreSQL path: with something claimable
    // there is no reason to walk the locked rows.
    if (!earliest) {
      this.reclaimExpired(subscriptionId, leaseMs, maxAttempts);
      earliest = this.findClaimable(subscriptionId);
    }

    if (!earliest) return null;

    earliest.lockedAt = new Date();
    earliest.attempts++;
    const msg = this.messages.get(earliest.messageId);
    if (!msg) return null;

    return {
      id: earliest.id,
      routingKey: msg.routingKey,
      data: msg.payload,
      createdAt: msg.createdAt,
    };
  }

  private read(subscriptionId: string, leaseMs: number, maxAttempts: number, signal?: AbortSignal): Promise<QueueEntry | null> {
    const entry = this.tryLockNext(subscriptionId, leaseMs, maxAttempts);

    if (entry) {
      return Promise.resolve(entry);
    }

    if (!signal) {
      return Promise.resolve(null);
    }

    return new Promise<QueueEntry | null>((resolve) => {
      let timer: ReturnType<typeof setInterval> | undefined = undefined;

      const tryRead = () => {
        const entry = this.tryLockNext(subscriptionId, leaseMs, maxAttempts);
        if (entry) {
          cleanup();
          resolve(entry);
        }
      };

      const onAbort = () => {
        cleanup();
        resolve(null);
      };

      const removeListener = this.addListener(subscriptionId, tryRead);

      const cleanup = () => {
        if (timer !== undefined) clearInterval(timer);
        removeListener();
        signal.removeEventListener('abort', onAbort);
      };

      signal.addEventListener('abort', onAbort, { once: true });

      if (signal.aborted) {
        onAbort();
        return;
      }

      // Notifications only fire on arrival, so a lease that expires while this
      // reader waits would go unnoticed — there is no new message to wake it.
      // Ticking at the lease cadence is the whole reason this timer exists,
      // which is why it is not the PostgreSQL path's fixed 1s: that one is
      // recovering a lost NOTIFY, a failure mode an in-process map does not have.
      if (leaseMs > 0) {
        timer = setInterval(tryRead, leaseMs);

        // A parked consumer is the normal resting state of this queue, so this
        // timer must never be the reason a process stays up: the engine parks one
        // per consumer and would otherwise hold the loop open on its own.
        try {
          Deno.unrefTimer(timer);
        } catch {
          // Not Deno, or the API moved. The sweep still runs; it just counts as work.
        }
      }
    });
  }

  private ack(deliveryId: QueueEntryId): void {
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery) return;

    const messageId = delivery.messageId;
    this.deliveries.delete(deliveryId);

    let hasOtherDelivery = false;
    for (const d of this.deliveries.values()) {
      if (d.messageId === messageId) {
        hasOtherDelivery = true;
        break;
      }
    }

    if (!hasOtherDelivery) {
      this.messages.delete(messageId);
    }
  }

  private nack(subscriptionId: string, deliveryId: QueueEntryId, maxAttempts: number): void {
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery || delivery.deadAt !== null) {
      // Already dead: a late close() on a handle whose lease had lapsed must not
      // resurrect the lock or log the entry a second time.
      return;
    }

    delivery.lockedAt = null;

    if (maxAttempts > 0 && delivery.attempts >= maxAttempts) {
      delivery.deadAt = new Date();
      logger.error('dead-lettering queue entry after repeated failures', {
        queue: subscriptionId,
        entry: delivery.id,
        attempts: delivery.attempts,
      });
    }
  }

  private truncate(subscriptionId: string): void {
    this.deleteDeliveriesForSubscription(subscriptionId);
    this.cleanOrphanMessages();
  }

  private deleteDeliveriesForSubscription(subscriptionId: string): void {
    for (const [id, d] of this.deliveries) {
      if (d.subscriptionId === subscriptionId) {
        this.deliveries.delete(id);
      }
    }
  }

  private cleanOrphanMessages(): void {
    const referencedMessages = new Set<number>();
    for (const d of this.deliveries.values()) {
      referencedMessages.add(d.messageId);
    }

    for (const id of this.messages.keys()) {
      if (!referencedMessages.has(id)) {
        this.messages.delete(id);
      }
    }
  }

  private addListener(subscriptionId: string, callback: () => void): () => void {
    let set = this.listeners.get(subscriptionId);
    if (!set) {
      set = new Set();
      this.listeners.set(subscriptionId, set);
    }
    set.add(callback);
    return () => {
      set!.delete(callback);
      if (set!.size === 0) this.listeners.delete(subscriptionId);
    };
  }

  private notifyListeners(subscriptionId: string): void {
    const set = this.listeners.get(subscriptionId);
    if (set) {
      for (const cb of set) cb();
    }
  }
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
