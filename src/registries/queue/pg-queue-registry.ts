import { Pool, PoolClient } from 'pg';
import { createLogger } from '../../managers/logger/mod.ts';
import type { RelayEventUnsubscriber } from '../../managers/router/mod.ts';
import { BoundRoutingKeys } from '../bound-routing-keys.ts';
import { routingPatternSources } from '../routing-key-match.ts';
import { countRelayEvent } from '../../lib/metrics/runtime.ts';
import { ensureResource, ResourceMode } from '../types.ts';
import { QueueHandle } from './queue-handle.ts';
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

const logger = createLogger('pg-queue-registry');

/** Messages deleted per statement by the orphan sweep. */
const ORPHAN_SWEEP_BATCH = 5000;

/** Published messages fanned out per statement at most. */
const RELAY_BATCH = 500;

/** A published message waiting for its fanout, and who waits on it. */
type Relayed = { routingKey: string; payload: unknown; done: PromiseWithResolvers<void> };

type PgQueueRegistryConfig = QueueRegistryConfig & {
  pool: Pool;
  name: string;
  /**
   * Pool the LISTEN connection comes from. Defaults to `pool`.
   *
   * The notification client is held for this registry's whole lifetime and can
   * never serve a query, so taking it from the work pool is a permanent
   * subtraction from it.
   */
  listenPool?: Pool;
};

export class PgQueueRegistry implements QueueRegistryIf {
  private initialized = false;
  private pool: Pool;
  private listenPool: Pool;
  private tablePrefix: string;
  private relayUnsubscribe: RelayEventUnsubscriber | undefined;

  // Shared LISTEN connection — one connection for all consumers
  private listenerConn?: PoolClient;
  private listenerReady?: Promise<void>;
  private listeners = new Map<string, Set<() => void>>();

  /** Which routing keys any subscription is bound to; skips the fanout entirely for the rest. */
  private bound = new BoundRoutingKeys(() => this.loadBoundKeys());

  /** When each subscription last swept expired leases, so an idle poll loop does not sweep every tick. */
  private lastReclaim = new Map<string, number>();

  /** Published messages not fanned out yet, in the order they were published. */
  private relayPending: Relayed[] = [];
  /** The fanout running now, which takes what is pending until nothing is. */
  private relaying?: Promise<void>;

  constructor(protected config: PgQueueRegistryConfig) {
    const name = `${config.name}_queues`;
    if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
      throw new Error(`Invalid table prefix: ${name}`);
    }
    this.tablePrefix = name;
    this.pool = config.pool;
    this.listenPool = config.listenPool ?? config.pool;
  }

  /** Initialize the schema and subscribe to relay events. */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.createSchema();

    const swept = await this.sweepOrphans();
    if (swept > 0) logger.warn('deleted queue messages no delivery referred to', { queues: this.tablePrefix, swept });

    // Before the relay is wired, so the first published event already has a
    // loaded set to consult rather than falling through to postgres.
    await this.bound.refresh();
    await this.watchSubscriptions();

    this.relayUnsubscribe = this.config.router.on(async (routingKey: string, payload: unknown) => {
      return await this.handleRelayEvent(routingKey, payload);
    });

    this.initialized = true;
  }

  /** Every routing key any subscription is currently bound to. */
  private async loadBoundKeys(): Promise<string[]> {
    const client = await this.pool.connect();

    try {
      const result = await client.query<{ routing_key: string }>(
        `SELECT DISTINCT unnest(routing_keys) AS routing_key FROM ${this.subscriptionsTable}`,
      );
      return result.rows.map((row) => row.routing_key);
    } finally {
      client.release();
    }
  }

  /**
   * Keep the bound set honest against writers we do not control.
   *
   * Our own `touch`/`delete` update the set directly, so this exists for the
   * case the direct path cannot see: a second process, or someone at a psql
   * prompt. The trigger fires on commit; an event published in the gap before
   * the notification arrives would still be missed, which is why the handler
   * goes permissive first and reloads second.
   */
  private async watchSubscriptions(): Promise<void> {
    try {
      await this.ensureListener();
    } catch {
      // No invalidation channel means we cannot trust the cache at all.
      this.bound.invalidate();
    }
  }

  /** Release the LISTEN connection and unsubscribe from relay events. */
  async dispose(): Promise<void> {
    if (this.listenerConn) {
      this.listenerConn.release();
      this.listenerConn = undefined;
      this.listenerReady = undefined;
      this.listeners.clear();
    }

    if (this.relayUnsubscribe) {
      this.relayUnsubscribe();
      this.relayUnsubscribe = undefined;
    }
    await this.relaying;
  }

  /** Create or update a queue subscription, returning true if a row was inserted or changed. */
  async touch(id: string, opts: QueueResourceOptions): Promise<boolean> {
    const routingKeys = opts.routingKeys ?? [];

    // Widened before the write, not after: an event published while this INSERT
    // is in flight must still reach the fanout. Being too permissive for a few
    // milliseconds costs one query; being too narrow loses a message.
    this.bound.add(routingKeys);

    const client = await this.pool.connect();

    try {
      const result = await client.query(
        `
        INSERT INTO ${this.subscriptionsTable} (id, routing_keys, routing_patterns)
        VALUES ($1, $2, $3)
        ON CONFLICT (id) DO UPDATE
          SET
            routing_keys = EXCLUDED.routing_keys,
            routing_patterns = EXCLUDED.routing_patterns
        WHERE
          ${this.subscriptionsTable}.routing_keys IS DISTINCT FROM EXCLUDED.routing_keys
          OR ${this.subscriptionsTable}.routing_patterns IS DISTINCT FROM EXCLUDED.routing_patterns
        `,
        [id, routingKeys, routingPatternSources(routingKeys)],
      );

      return result.rowCount === 1;
    } finally {
      client.release();
    }
  }

  /** Open a queue handle for reading/writing, optionally truncating existing entries. */
  async open(id: string, opts: QueueResourceOptions, mode?: ResourceMode): Promise<QueueHandle> {
    const { truncate } = await ensureResource(this, id, opts, mode);

    if (truncate) {
      await this.truncate(id);
    }

    const io: QueueIO = {
      append: async (data: unknown): Promise<QueueEntryId> => {
        return await this.append(id, data);
      },
      read: async (signal?: AbortSignal): Promise<QueueEntry | null> => {
        return await this.read(id, opts.leaseMs ?? QUEUE_DEFAULT_LEASE_MS, opts.maxAttempts ?? QUEUE_DEFAULT_MAX_ATTEMPTS, signal);
      },
      ack: async (entryId: QueueEntryId): Promise<void> => {
        return await this.ack(entryId);
      },
      nack: async (entryId: QueueEntryId): Promise<void> => {
        return await this.nack(id, entryId, opts.maxAttempts ?? QUEUE_DEFAULT_MAX_ATTEMPTS);
      },
    };

    const rh = new QueueHandle(id, opts, mode || 'r', this, io);
    await rh.init();

    return rh;
  }

  /** Check whether a queue subscription with the given id exists. */
  async exists(id: string): Promise<boolean> {
    const client = await this.pool.connect();

    try {
      const result = await client.query<{ exists: boolean }>(
        `
        SELECT EXISTS (
          SELECT 1 FROM ${this.subscriptionsTable} WHERE id = $1
        ) AS exists
        `,
        [id],
      );

      return result.rows[0]?.exists ?? false;
    } finally {
      client.release();
    }
  }

  /**
   * The first live deliveries in claim order, read without `FOR UPDATE`: a peek
   * locks nothing and spends no attempt, so a consumer never waits on it.
   */
  async peek(id: string, limit: number): Promise<QueuePeekEntry[]> {
    const client = await this.pool.connect();

    try {
      const exists = await client.query(`SELECT 1 FROM ${this.subscriptionsTable} WHERE id = $1`, [id]);

      if (exists.rows.length === 0) {
        throw new Error(`no queue found: ${id}`);
      }

      const result = await client.query<{
        delivery_id: QueueEntryId;
        routing_key: string;
        payload: unknown;
        created_at: Date;
        locked: boolean;
        attempts: number;
      }>(
        `
          SELECT d.id AS delivery_id, m.routing_key, m.payload, m.created_at,
                 d.locked_at IS NOT NULL AS locked, d.attempts
            FROM ${this.deliveriesTable} d
            JOIN ${this.messagesTable} m ON m.id = d.message_id
            WHERE d.subscription_id = $1 AND d.dead_at IS NULL
            ORDER BY d.id
            LIMIT $2
        `,
        [id, Math.max(0, Math.floor(limit))],
      );

      return result.rows.map((r) => ({
        id: Number(r.delivery_id),
        routingKey: r.routing_key,
        data: r.payload,
        createdAt: r.created_at,
        state: r.locked ? 'in-flight' as const : 'ready' as const,
        attempts: Number(r.attempts),
      }));
    } finally {
      client.release();
    }
  }

  async deadLetters(id: string, limit: number): Promise<QueueDeadEntry[]> {
    await this.assertQueue(id);

    const result = await this.pool.query<{
      delivery_id: QueueEntryId;
      routing_key: string;
      payload: unknown;
      created_at: Date;
      attempts: number;
      dead_at: Date;
    }>(
      `
        SELECT d.id AS delivery_id, m.routing_key, m.payload, m.created_at, d.attempts, d.dead_at
          FROM ${this.deliveriesTable} d
          JOIN ${this.messagesTable} m ON m.id = d.message_id
          WHERE d.subscription_id = $1 AND d.dead_at IS NOT NULL
          ORDER BY d.id
          LIMIT $2
      `,
      [id, Math.max(0, Math.floor(limit))],
    );

    return result.rows.map((r) => ({
      id: Number(r.delivery_id),
      routingKey: r.routing_key,
      data: r.payload,
      createdAt: r.created_at,
      attempts: Number(r.attempts),
      deadAt: r.dead_at,
    }));
  }

  async settleDead(id: string, action: QueueDeadAction, ids?: QueueEntryId[]): Promise<number> {
    await this.assertQueue(id);

    const params: unknown[] = [id];
    let only = '';
    if (ids) {
      params.push(ids);
      only = 'AND id = ANY($2::bigint[])';
    }

    if (action === 'drop') {
      const res = await this.pool.query(`DELETE FROM ${this.deliveriesTable} WHERE subscription_id = $1 AND dead_at IS NOT NULL ${only}`, params);
      await this.sweepOrphans();
      return res.rowCount ?? 0;
    }

    const res = await this.pool.query(
      `UPDATE ${this.deliveriesTable} SET dead_at = NULL, locked_at = NULL, attempts = 0 WHERE subscription_id = $1 AND dead_at IS NOT NULL ${only}`,
      params,
    );
    // The notify trigger fires on insert only; a waiting consumer is told here rather than at its next poll.
    if ((res.rowCount ?? 0) > 0) await this.pool.query(`SELECT pg_notify($1, $2)`, [this.deliveriesChannel, id]);
    return res.rowCount ?? 0;
  }

  private async assertQueue(id: string): Promise<void> {
    const exists = await this.pool.query(`SELECT 1 FROM ${this.subscriptionsTable} WHERE id = $1`, [id]);
    if (exists.rows.length === 0) throw new Error(`no queue found: ${id}`);
  }

  /** Return the claimable/in-flight delivery counts and routing keys for a queue. */
  async stat(id: string): Promise<QueueStat> {
    const client = await this.pool.connect();

    try {
      const result = await client.query<{ routing_keys: string[] }>(
        `
          SELECT * FROM ${this.subscriptionsTable}
          WHERE id = $1
        `,
        [id],
      );

      if (result.rows.length === 0) {
        throw new Error(`no queue found: ${id}`);
      }

      // Split rather than a plain COUNT(*). A held entry is not backlog, and the
      // oldest lock age is the one number that separates "consumers are busy"
      // from "these are stranded" without having to look at the table.
      // Dead-lettered rows are excluded from both live counts rather than folded
      // into either: they are neither backlog nor work in progress, and counting
      // them as depth is what would make a wedged queue read as a busy one.
      const result2 = await client.query<{ ready: string; in_flight: string; dead: string; oldest_ms: string | null }>(
        `
          SELECT
            COUNT(*) FILTER (WHERE locked_at IS NULL AND dead_at IS NULL) AS ready,
            COUNT(*) FILTER (WHERE locked_at IS NOT NULL AND dead_at IS NULL) AS in_flight,
            COUNT(*) FILTER (WHERE dead_at IS NOT NULL) AS dead,
            FLOOR(EXTRACT(EPOCH FROM (now() - MIN(locked_at) FILTER (WHERE dead_at IS NULL))) * 1000) AS oldest_ms
          FROM ${this.deliveriesTable}
          WHERE subscription_id = $1;
        `,
        [id],
      );

      const row = result2.rows[0];

      return {
        size: Number(row.ready),
        inFlight: Number(row.in_flight),
        oldestInFlightMs: Math.max(0, Number(row.oldest_ms ?? 0)),
        deadLettered: Number(row.dead),
        routingKeys: result.rows[0].routing_keys,
      };
    } finally {
      client.release();
    }
  }

  /** Alias for {@link stat}; returns the same resource stats. */
  async statX(id: string): Promise<QueueStat> {
    return this.stat(id);
  }

  /** Delete a queue subscription and its deliveries, cleaning up orphaned messages. */
  async delete(id: string): Promise<boolean> {
    // The cascade deletes its deliveries. The sweep runs after the commit, not
    // inside it: in the same transaction it held the subscription row, which
    // every publish's foreign-key check on a new delivery waits for.
    const result = await this.pool.query(`DELETE FROM ${this.subscriptionsTable} WHERE id = $1`, [id]);
    await this.sweepOrphans();

    // Reloaded rather than subtracted: another subscription may still hold a
    // key this one had, and a refcount that drifted would drop deliveries.
    await this.bound.refresh();
    this.lastReclaim.delete(id);

    return result.rowCount === 1;
  }

  /** List all queue subscription ids as an async iterable. */
  async list(): Promise<AsyncIterable<string>> {
    const client = await this.pool.connect();

    try {
      const result = await client.query<{ id: string }>(
        `SELECT id FROM ${this.subscriptionsTable}`,
      );

      return (async function* () {
        for (const row of result.rows) {
          yield row.id;
        }
      })();
    } finally {
      client.release();
    }
  }

  /** Return the total number of queue subscriptions. */
  async count(_id?: string): Promise<number> {
    const client = await this.pool.connect();

    try {
      const result = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM ${this.subscriptionsTable}`,
      );

      return Number(result.rows[0]?.count ?? '0');
    } finally {
      client.release();
    }
  }

  private async truncate(id: string) {
    await this.pool.query(`DELETE FROM ${this.deliveriesTable} WHERE subscription_id = $1`, [id]);
    await this.sweepOrphans();
  }

  /**
   * Fan a published message out to every subscription bound to its routing key. Resolves once its
   * fanout is written. Messages published while one fanout runs wait for it and go out together in
   * the next (`drainRelay`), so a write that publishes a message per file costs a statement per
   * batch, not one per file, and they keep the order they were published in.
   */
  private handleRelayEvent(routingKey: string, payload: unknown): Promise<void> {
    // The cheap half of the fanout, done without a connection. Most published keys —
    // `system.vfs.tty.updated` above all, which a crawl emits for every line a step prints — are
    // bound to nothing, and asking postgres to confirm that would cost a pooled client and a
    // round-trip every time.
    if (!this.bound.has(routingKey)) {
      countRelayEvent(false);
      return Promise.resolve();
    }

    countRelayEvent(true);
    const done = Promise.withResolvers<void>();
    this.relayPending.push({ routingKey, payload, done });
    this.relaying ??= this.drainRelay();
    return done.promise;
  }

  /** Fan out what is pending, `RELAY_BATCH` messages a statement, until nothing is. */
  private async drainRelay(): Promise<void> {
    try {
      while (this.relayPending.length > 0) {
        const batch = this.relayPending.splice(0, RELAY_BATCH);
        try {
          await this.fanout(batch);
          for (const message of batch) message.done.resolve();
        } catch (error) {
          for (const message of batch) message.done.reject(error);
        }
      }
    } finally {
      this.relaying = undefined;
    }
  }

  /**
   * One statement for `batch`, persisting nothing for a message no subscription matches: every
   * VFS mutation in the system is published, and a message row with no delivery is only work for
   * the orphan sweep. Message ids are drawn in the batch's order, and deliveries insert last so
   * the NOTIFY trigger on that table fires only for messages that are actually deliverable.
   *
   * The two branches are a UNION rather than an OR so the pattern branch reads only the
   * subscriptions that bound a pattern, through their partial index.
   */
  private async fanout(batch: Relayed[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `
          WITH input AS (
            SELECT k.ord, k.routing_key, k.payload
            FROM ROWS FROM (unnest($1::text[]), jsonb_array_elements($2::jsonb)) WITH ORDINALITY AS k(routing_key, payload, ord)
          ), routed AS (
            SELECT i.ord, s.id AS subscription_id FROM input i JOIN ${this.subscriptionsTable} s ON i.routing_key = ANY(s.routing_keys)
            UNION
            SELECT i.ord, s.id FROM input i JOIN ${this.subscriptionsTable} s
              ON s.routing_patterns <> '{}' AND i.routing_key ~ ANY(s.routing_patterns)
          ), numbered AS (
            SELECT d.ord, d.routing_key, d.payload, nextval(pg_get_serial_sequence('${this.messagesTable}', 'id')) AS id
            FROM (SELECT i.* FROM input i WHERE EXISTS (SELECT 1 FROM routed r WHERE r.ord = i.ord) ORDER BY i.ord) d
          ), msg AS (
            INSERT INTO ${this.messagesTable} (id, routing_key, payload)
            SELECT id, routing_key, payload FROM numbered ORDER BY ord
          )
          INSERT INTO ${this.deliveriesTable} (subscription_id, message_id)
          SELECT r.subscription_id, n.id FROM routed r JOIN numbered n ON n.ord = r.ord ORDER BY n.ord, r.subscription_id
        `,
        [batch.map((message) => message.routingKey), JSON.stringify(batch.map((message) => message.payload ?? null))],
      );
    } finally {
      client.release();
    }
  }

  private async append(id: string, payload: unknown): Promise<QueueEntryId> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const msgRes = await client.query<{ id: QueueEntryId }>(
        `
          INSERT INTO ${this.messagesTable} (routing_key, payload)
          VALUES ($1, $2::jsonb)
          RETURNING id
        `,
        ['-', JSON.stringify(payload)],
      );
      const messageId = msgRes.rows[0].id;

      const delRes = await client.query<{ id: QueueEntryId }>(
        `
          INSERT INTO ${this.deliveriesTable} (subscription_id, message_id)
          VALUES ($1, $2)
          RETURNING id
        `,
        [id, messageId],
      );

      await client.query('COMMIT');

      return delRes.rows[0].id;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Claim the next unlocked delivery, sweeping expired leases first if the
   * queue looks empty.
   *
   * The sweep is deliberately behind the miss: under load there is always a
   * ready row, the fast path takes it, and nothing extra runs. It only fires in
   * the state that actually needs it — nothing claimable but rows still locked,
   * which is precisely how a stranded lock presents. Rate-limited to one sweep
   * per lease per subscription so a queue that is simply idle does not run an
   * UPDATE on every 1s poll tick of every waiting consumer.
   */
  private async claim(id: string, leaseMs: number, maxAttempts: number, executor: Pool | PoolClient): Promise<QueueEntry | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await executor.query<{
        delivery_id: QueueEntryId;
        routing_key: string;
        payload: unknown;
        created_at: Date;
      }>(
        `
      UPDATE ${this.deliveriesTable} d
        SET locked_at = now(), attempts = d.attempts + 1
        FROM ${this.messagesTable} m
        WHERE d.message_id = m.id
          AND d.subscription_id = $1
          AND d.id = (
            SELECT d2.id FROM ${this.deliveriesTable} d2
              WHERE d2.subscription_id = $1 AND d2.locked_at IS NULL AND d2.dead_at IS NULL
              ORDER BY d2.id LIMIT 1
              FOR UPDATE SKIP LOCKED
          )
        RETURNING d.id as delivery_id, m.routing_key, m.payload, m.created_at
        `,
        [id],
      );

      if (res.rows.length > 0) {
        const r = res.rows[0];
        return {
          id: r.delivery_id,
          routingKey: r.routing_key,
          data: r.payload,
          createdAt: r.created_at,
        };
      }

      if (attempt > 0 || !(await this.reclaimExpired(id, leaseMs, maxAttempts, executor))) {
        return null;
      }
    }

    return null;
  }

  /**
   * Unlock deliveries whose lease has run out, dead-lettering any that have no
   * attempts left. Returns true if any became claimable again.
   *
   * The lease path spends an attempt just as a nack does: a consumer that dies
   * holding an entry never nacks it, so bounding only the nack would leave the
   * crash-loop half of the poison-message problem redelivering forever.
   */
  private async reclaimExpired(id: string, leaseMs: number, maxAttempts: number, executor: Pool | PoolClient): Promise<boolean> {
    if (leaseMs <= 0) {
      return false;
    }

    const now = Date.now();
    const last = this.lastReclaim.get(id) ?? 0;

    if (now - last < leaseMs) {
      return false;
    }

    this.lastReclaim.set(id, now);

    const res = await executor.query<{ dead: boolean }>(
      `
        UPDATE ${this.deliveriesTable}
          SET locked_at = NULL,
              dead_at = CASE WHEN $3::int > 0 AND attempts >= $3::int THEN now() ELSE NULL END
          WHERE subscription_id = $1
            AND locked_at IS NOT NULL
            AND dead_at IS NULL
            AND locked_at < now() - ($2::bigint * INTERVAL '1 millisecond')
          RETURNING dead_at IS NOT NULL AS dead
      `,
      [id, leaseMs, maxAttempts],
    );

    const dead = res.rows.filter((row) => row.dead).length;
    const freed = res.rows.length - dead;

    if (freed > 0) {
      logger.warn('reclaimed expired queue leases', { queue: id, freed, leaseMs });
    }

    if (dead > 0) {
      logger.error('dead-lettered queue entries after exhausted leases', { queue: id, dead, maxAttempts });
    }

    // Only the ones that came back are worth a second claim pass.
    return freed > 0;
  }

  private async read(id: string, leaseMs: number, maxAttempts: number, signal?: AbortSignal): Promise<QueueEntry | null> {
    const client = await this.pool.connect();
    let claimed: QueueEntry | null;

    try {
      claimed = await this.claim(id, leaseMs, maxAttempts, client);
    } finally {
      // Released before the wait, not across it. Everything below claims through
      // `this.pool`, so a client held here would do nothing but stand idle — and
      // for a consumer parked on an empty queue that is forever.
      client.release();
    }

    if (claimed) {
      return claimed;
    }

    // Non-blocking: return null immediately
    if (!signal) {
      return null;
    }

    // Blocking: wait for LISTEN/NOTIFY, backed by a safety-net poll. A
    // transient DB error (e.g. Postgres restarting mid-init on a clean DB)
    // must NEVER resolve null here — consumers read null as EOF and would die
    // silently. Only a genuine abort resolves null; everything else retries.
    await this.ensureListener();

    const entry = await new Promise<QueueEntry | null>((resolve) => {
      let settled = false;
      let polling = false;
      let timer: ReturnType<typeof setInterval> | undefined = undefined;

      // Reports whether it accepted the value, so a caller that lost the race
      // knows it is holding something nobody will ever receive.
      const settle = (value: QueueEntry | null): boolean => {
        if (settled) return false;
        settled = true;
        cleanup();
        resolve(value);
        return true;
      };

      const tryRead = async () => {
        // Serialize polls for this waiter so a NOTIFY and a timer tick can't
        // both lock a row (the loser's lock would orphan, never acked).
        if (settled || polling) return;
        polling = true;
        try {
          const claimed = await this.claim(id, leaseMs, maxAttempts, this.pool);

          // An abort can land while this claim is in flight: the row is now
          // locked and the consumer is gone. Hand it straight back rather
          // than leaving it stranded until the lease lapses.
          if (claimed && !settle(claimed)) {
            await this.nack(id, claimed.id, maxAttempts).catch(() => {});
          }
          // No rows: keep waiting for the next notification / poll tick.
        } catch {
          // Transient error — drop the (possibly dead) listener so it
          // reconnects and let the poll timer retry. Never resolve here.
          this.resetListener();
          void this.ensureListener().catch(() => {});
        } finally {
          polling = false;
        }
      };

      const onAbort = () => settle(null);

      const removeListener = this.addListener(id, tryRead);

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

      // Safety net: recovers a NOTIFY lost in the gap before addListener and a
      // listener connection that died without delivering. NOTIFY stays the
      // fast path; this only guarantees forward progress.
      timer = setInterval(tryRead, 1000);
      void tryRead();
    });

    return entry;
  }

  /**
   * Drop the delivery and, if it was the last one, the message with it.
   *
   * Two statements, each its own transaction, and the second only after the
   * first has committed. A fanned-out message has one delivery per
   * subscription, and its consumers ack it at nearly the same moment: done in
   * one statement, each ack's `NOT EXISTS` ran on a snapshot that still held the
   * other's uncommitted delivery, neither deleted the message, and on fry every
   * `system.vfs.file.updated` message (bound by two queues) was left behind. Run
   * apart, whichever ack checks last sees both deliveries gone; if both see it,
   * the second delete finds nothing.
   */
  private async ack(deliveryId: QueueEntryId): Promise<void> {
    const del = await this.pool.query<{ message_id: string }>(
      `DELETE FROM ${this.deliveriesTable} WHERE id = $1 RETURNING message_id`,
      [deliveryId],
    );
    const messageId = del.rows[0]?.message_id;
    if (messageId === undefined) return;

    await this.pool.query(
      `
        DELETE FROM ${this.messagesTable} m
        WHERE m.id = $1
          AND NOT EXISTS (SELECT 1 FROM ${this.deliveriesTable} d WHERE d.message_id = m.id)
      `,
      [messageId],
    );
  }

  /**
   * Delete messages no delivery refers to, a batch per statement.
   *
   * `ack` removes a message with its last delivery, but a subscription's
   * `delete` or `truncate` racing another subscription's ack can still leave
   * one behind, so this runs at init as well as after those two. Batched so a large
   * backlog is many short transactions rather than one that holds its locks
   * for minutes. Returns the number deleted.
   */
  private async sweepOrphans(): Promise<number> {
    let total = 0;
    for (;;) {
      const res = await this.pool.query(
        `
          DELETE FROM ${this.messagesTable}
          WHERE id IN (
            SELECT m.id FROM ${this.messagesTable} m
            WHERE NOT EXISTS (SELECT 1 FROM ${this.deliveriesTable} d WHERE d.message_id = m.id)
            LIMIT ${ORPHAN_SWEEP_BATCH}
          )
        `,
      );
      total += res.rowCount ?? 0;
      if ((res.rowCount ?? 0) < ORPHAN_SWEEP_BATCH) return total;
    }
  }

  private async nack(id: string, deliveryId: QueueEntryId, maxAttempts: number): Promise<void> {
    // Unlock and dead-letter in one statement, on the row's own attempt count:
    // several consumers compete for this queue, so a read-then-write would race
    // against whichever of them claimed the entry next.
    const res = await this.pool.query<{ dead: boolean }>(
      `
        UPDATE ${this.deliveriesTable}
          SET locked_at = NULL,
              dead_at = CASE WHEN $2::int > 0 AND attempts >= $2::int THEN now() ELSE NULL END
          WHERE id = $1 AND dead_at IS NULL
          RETURNING dead_at IS NOT NULL AS dead
      `,
      [deliveryId, maxAttempts],
    );

    if (res.rows[0]?.dead) {
      logger.error('dead-lettering queue entry after repeated failures', { queue: id, entry: deliveryId, maxAttempts });
    }
  }

  private ensureListener(): Promise<void> {
    if (this.listenerReady) return this.listenerReady;
    this.listenerReady = (async () => {
      const conn = await this.listenPool.connect();
      conn.on('notification', (msg) => {
        // The subscriptions channel rides the same connection rather than
        // opening a second one: this registry already costs the listen pool a
        // permanent client, and one more for a notification that fires a few
        // times per boot would be hard to justify.
        if (msg.channel === this.subscriptionsChannel) {
          this.bound.invalidate();
          void this.bound.refresh();
          return;
        }
        if (msg.channel !== this.deliveriesChannel) return;
        const subscriptionId = msg.payload;
        if (!subscriptionId) return;
        const callbacks = this.listeners.get(subscriptionId);
        if (callbacks) {
          for (const cb of callbacks) cb();
        }
      });
      // The LISTEN connection can drop (e.g. Postgres restart). Drop it so the
      // next ensureListener reconnects; waiting reads keep progressing via their
      // poll timer in the meantime.
      conn.on('error', () => this.resetListener());
      await conn.query(`LISTEN ${this.deliveriesChannel}`);
      await conn.query(`LISTEN ${this.subscriptionsChannel}`);
      this.listenerConn = conn;

      // A reconnect means notifications were missed while the connection was
      // down, so the set is reloaded rather than resumed.
      void this.bound.refresh();
    })().catch((err) => {
      // Don't cache a rejected promise — reconnect on the next call.
      this.listenerReady = undefined;
      throw err;
    });
    return this.listenerReady;
  }

  /** Drop the shared LISTEN connection so the next ensureListener reconnects. */
  private resetListener(): void {
    // Without the connection there is no invalidation channel, so the bound set
    // can no longer be trusted — go permissive until a reconnect reloads it.
    this.bound.invalidate();

    const conn = this.listenerConn;
    this.listenerConn = undefined;
    this.listenerReady = undefined;
    if (conn) {
      try {
        conn.removeAllListeners('notification');
        conn.removeAllListeners('error');
        conn.release(true); // destroy — the connection may be broken
      } catch {
        // ignore
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

  private async createSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.messagesTable} (
          id            BIGSERIAL PRIMARY KEY,
          routing_key   TEXT NOT NULL,
          payload       JSONB NOT NULL,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);

      // `routing_patterns` holds the compiled regex of every wildcard binding in
      // `routing_keys`, written by `touch`. Compiling in
      // TS and storing the result is what keeps one set of pattern semantics for both
      // backends — postgres only ever runs the regex.
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.subscriptionsTable} (
          id                VARCHAR(26) PRIMARY KEY,
          routing_keys      TEXT[] NOT NULL DEFAULT '{}',
          routing_patterns  TEXT[] NOT NULL DEFAULT '{}',
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.subscriptionsTable}_routing_keys_idx
        ON ${this.subscriptionsTable}
        USING GIN (routing_keys);
      `);

      // Partial, so the fanout's pattern branch scans only subscriptions that bound a
      // pattern — normally none, and the branch costs nothing on a system with none.
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.subscriptionsTable}_routing_patterns_idx
        ON ${this.subscriptionsTable} (id)
        WHERE routing_patterns <> '{}';
      `);

      // `attempts` counts deliveries handed out, not nacks: the lease sweep has
      // to spend one too, or a consumer that dies on an entry instead of nacking
      // it would still be redelivered forever. `dead_at` is a state, not a
      // delete — the poison message is the one message worth being able to look
      // at afterwards.
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.deliveriesTable} (
          id              BIGSERIAL PRIMARY KEY,
          subscription_id VARCHAR(26) REFERENCES ${this.subscriptionsTable}(id) ON DELETE CASCADE,
          message_id      BIGINT REFERENCES ${this.messagesTable}(id) ON DELETE CASCADE,
          locked_at       TIMESTAMPTZ,
          attempts        INTEGER NOT NULL DEFAULT 0,
          dead_at         TIMESTAMPTZ,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE(subscription_id, message_id)
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.deliveriesTable}_claimable_idx
          ON ${this.deliveriesTable}(subscription_id)
          WHERE locked_at IS NULL AND dead_at IS NULL
      `);

      // The mirror image, for the lease sweep. Partial in the other direction so
      // the claim path's index stays exactly as narrow as it was: under load
      // nothing is locked for long and this one is nearly empty.
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.deliveriesTable}_locked_idx
          ON ${this.deliveriesTable}(subscription_id, locked_at)
          WHERE locked_at IS NOT NULL
      `);

      // For "does this message still have a delivery": ack's cleanup, the orphan
      // sweep, and the cascade from a deleted message all look it up by message.
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.deliveriesTable}_message_idx
          ON ${this.deliveriesTable}(message_id)
      `);

      // Trigger notifies with subscription_id so listeners can filter by queue
      await client.query(`
        CREATE OR REPLACE FUNCTION ${this.deliveriesTable}_notify_trigger()
        RETURNS trigger AS $$
        BEGIN
          PERFORM pg_notify('${this.deliveriesChannel}', NEW.subscription_id);
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);

      await client.query(`
        DROP TRIGGER IF EXISTS ${this.deliveriesTable}_notify ON ${this.deliveriesTable};
        CREATE TRIGGER ${this.deliveriesTable}_notify
        AFTER INSERT ON ${this.deliveriesTable}
        FOR EACH ROW EXECUTE FUNCTION ${this.deliveriesTable}_notify_trigger();
      `);

      // Invalidates the in-process bound-routing-key cache. STATEMENT level, not
      // ROW: the payload is unused because the handler reloads the whole set, so
      // a multi-row change needs exactly one notification.
      await client.query(`
        CREATE OR REPLACE FUNCTION ${this.subscriptionsTable}_notify_trigger()
        RETURNS trigger AS $$
        BEGIN
          PERFORM pg_notify('${this.subscriptionsChannel}', '');
          RETURN NULL;
        END;
        $$ LANGUAGE plpgsql;
      `);

      await client.query(`
        DROP TRIGGER IF EXISTS ${this.subscriptionsTable}_notify ON ${this.subscriptionsTable};
        CREATE TRIGGER ${this.subscriptionsTable}_notify
        AFTER INSERT OR UPDATE OR DELETE ON ${this.subscriptionsTable}
        FOR EACH STATEMENT EXECUTE FUNCTION ${this.subscriptionsTable}_notify_trigger();
      `);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // Table name helpers
  private get messagesTable() {
    return `${this.tablePrefix}_msg`;
  }

  private get subscriptionsTable() {
    return `${this.tablePrefix}`;
  }

  private get deliveriesTable() {
    return `${this.tablePrefix}_lnk`;
  }

  private get deliveriesChannel() {
    return `${this.deliveriesTable}_com`;
  }

  private get subscriptionsChannel() {
    return `${this.subscriptionsTable}_sub`;
  }
}
