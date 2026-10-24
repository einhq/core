import type { Wire } from './ids.ts';

/** A single message delivery read from a queue. */
export interface QueueEntry {
  /** Delivery id used for ack/nack. */
  id: QueueEntryId;
  /** Routing key the original message was published to. */
  routingKey: string;
  /** Timestamp when the message was created. */
  createdAt: Date;
  /** The message payload. */
  data: unknown;
}

/**
 * An entry as a peek sees it: what `read` would hand out, in the order it
 * would, and whether a consumer is holding it right now.
 */
export interface QueuePeekEntry extends QueueEntry {
  /** `ready` is claimable; `in-flight` is held by a consumer and not yet acked. */
  state: 'ready' | 'in-flight';
  /** Deliveries handed out so far. */
  attempts: number;
}

/** An entry that ran out of delivery attempts and is no longer handed out. */
export interface QueueDeadEntry extends QueueEntry {
  /** Deliveries handed out before it was set aside. */
  attempts: number;
  /** When it ran out of attempts. */
  deadAt: Date;
}

export type QueueStat = {
  /**
   * Entries claimable right now. Deliberately *not* the row count: an entry a
   * consumer is holding is not backlog, and counting it would report the same
   * depth for a wedged queue as for a draining one.
   */
  size: number;
  /** Entries currently held unacked by a consumer. */
  inFlight: number;
  /** Age of the oldest in-flight entry in ms, `0` when none. */
  oldestInFlightMs: number;
  /**
   * Entries that exhausted `maxAttempts` and will not be delivered again.
   *
   * Kept as rows rather than deleted: a poison message is the one message worth
   * looking at, and a queue that silently dropped it would leave nothing to
   * explain why the work never happened.
   */
  deadLettered: number;
  routingKeys: string[];
};

export type LogStat = {
  retention: string;
  size: number;
  routingKeys: string[];
};

/** Unique identifier for a queue delivery entry (bigserial from PostgreSQL). */
export type QueueEntryId = number;

/** `queue-dead`: the entries a queue set aside, or with `--retry`/`--drop` how many were settled. */
export type QueueDead = { items: Wire<QueueDeadEntry>[] } | { ok: true; settled: number };

/** `queue-peek`: what a reader would get next, without taking it. */
export type QueuePeek = { items: Wire<QueuePeekEntry>[] };
