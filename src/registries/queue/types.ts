import type { RouterManagerIf } from '../../managers/router/mod.ts';
import { RegistryIf, ResourceOptions } from '../types.ts';
import type { QueueDeadEntry, QueueEntry, QueuePeekEntry, QueueStat } from '../../lib/api/streams.ts';
import type { QueueEntryId } from '../../lib/api/streams.ts';
export type { QueueEntryId } from '../../lib/api/streams.ts';
export type { QueueDeadEntry, QueueEntry, QueuePeekEntry, QueueStat } from '../../lib/api/streams.ts';

/** What becomes of dead-lettered entries: handed out again with fresh attempts, or deleted. */
export type QueueDeadAction = 'retry' | 'drop';

export type QueueResourceOptions = ResourceOptions & {
  routingKeys?: string[];
  /**
   * How long a consumer may hold an entry unacked before it is handed back.
   *
   * Without this a lock is forever: `read` only ever claims an unlocked row, so
   * a consumer killed mid-entry — a container restart, an OOM — takes that
   * entry with it. Consumers are expected to be at-least-once, so redelivering
   * is strictly better than losing.
   *
   * `0` disables reclaim entirely.
   */
  leaseMs?: number;
  /**
   * How many times an entry may be delivered before it is dead-lettered.
   *
   * A nack only clears `locked_at`, so without a bound a message that can never
   * succeed — a node that no longer resolves, a payload the rules cannot parse —
   * is handed straight back on the next poll tick to a consumer that will fail
   * on it again, forever.
   *
   * Counted per delivery rather than per nack, so the crash-loop variant is
   * bounded too: a consumer that dies holding an entry never nacks it, and the
   * lease sweep would otherwise redeliver it just as endlessly.
   *
   * `0` disables the bound, restoring retry-forever.
   */
  maxAttempts?: number;
};

/** Default consumer lease, matching `POOL_DEFAULTS.leaseMs`. */
export const QUEUE_DEFAULT_LEASE_MS = 60_000;

/**
 * Default delivery attempts before dead-lettering.
 *
 * Higher than the pool's `maxAttempts: 3` because a queue has no backoff: the
 * redelivery is immediate, so the count is the *only* tolerance a transient
 * failure gets. Three attempts would be three seconds, which is short enough to
 * dead-letter on a database blip.
 */
export const QUEUE_DEFAULT_MAX_ATTEMPTS = 10;

/** Configuration for creating a queue registry. */
export type QueueRegistryConfig = {
  /** Router manager used to receive routed events for fanout delivery. */
  router: RouterManagerIf;
};

/** Low-level I/O operations for a single queue. */
export interface QueueIO {
  /** Append a message directly to the queue, returning its delivery id. */
  append(data: unknown): Promise<QueueEntryId>;
  /** Read the next unlocked entry, optionally blocking until one arrives. */
  read(signal?: AbortSignal): Promise<QueueEntry | null>;
  /** Acknowledge a delivery, removing it and cleaning up orphaned messages. */
  ack(id: QueueEntryId): Promise<void>;
  /**
   * Negative-acknowledge a delivery, unlocking it for redelivery — or
   * dead-lettering it once it has used up `maxAttempts` deliveries.
   */
  nack(id: QueueEntryId): Promise<void>;
}

/**
 * Message queue with routing-key based fanout and competing consumers.
 *
 * Messages are published to a routing key. Durable queues bound to that
 * routing key each receive a copy (fanout). Multiple consumers on the
 * same queue compete — only one receives each message.
 *
 * ```
 * publish("jobs.index", payload)
 *        │
 *        ▼  fanout to matching queues
 *   ┌────┴─────┐
 *   ▼          ▼
 * "indexer"  "audit"        ← ensureQueue(name, routingKey)
 *   │          │
 * ┌─┴─┐     ┌─┴─┐
 * C1  C2    C3  C4          ← consumeQueue (competing)
 * ```
 */
export interface QueueRegistryIf extends RegistryIf<QueueResourceOptions, QueueStat> {
  /**
   * The first `limit` live entries in delivery order, without claiming any.
   *
   * Reading a queue consumes it, so this is the only way to look at one: what is
   * waiting and what is being worked on. Dead-lettered entries are left out;
   * `stat` counts them.
   */
  peek(id: string, limit: number): Promise<QueuePeekEntry[]>;

  /** The first `limit` dead-lettered entries, oldest delivery first. */
  deadLetters(id: string, limit: number): Promise<QueueDeadEntry[]>;

  /**
   * Retry or drop dead-lettered entries: all of them, or those of `ids` that are dead. A retried
   * entry starts over with no attempts spent; a dropped one is deleted, and its message with its
   * last delivery. Returns how many entries were settled.
   */
  settleDead(id: string, action: QueueDeadAction, ids?: QueueEntryId[]): Promise<number>;
}
