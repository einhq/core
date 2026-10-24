import { createHash } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import type { RelayEventUnsubscriber, RouterManagerIf } from '../../managers/router/mod.ts';
import { BoundRoutingKeys } from '../bound-routing-keys.ts';
import { routingKeysMatch, routingPatternSources } from '../routing-key-match.ts';
import { ensureResource, ResourceMode, ResourceSeekMode } from '../types.ts';
import { LogHandle } from './log-handle.ts';
import { LogEntry, LogEntryId, LogIO, LogRegistryIf, LogResourceOptions, LogStat, ParsedRetention, parseRetention } from './types.ts';

type PgLogRegistryConfig = {
  pool: Pool;
  name: string;
  router: RouterManagerIf;
  /**
   * Pool the LISTEN connection comes from. Defaults to `pool`.
   *
   * The notification client is held for this registry's whole lifetime and can
   * never serve a query, so taking it from the work pool is a permanent
   * subtraction from it.
   */
  listenPool?: Pool;
};

/**
 * How many relayed events one flush carries.
 *
 * The relay is a fan-in: every `logger.*` call in the process publishes, and nothing on that
 * path awaits anything, so arrival rate is set by how busy EiN is and the writer has to
 * keep up on its own. A SELECT plus an INSERT per event cannot under load, and any permanent
 * deficit stays in memory until the heap is full.
 */
const RELAY_BATCH = 500;

/**
 * Ceiling on the pending relay backlog. Past this, the oldest events are dropped and counted.
 *
 * Dropping log lines is the right failure mode: an unbounded in-memory queue in front of a
 * slower writer trades a visible gap in the log for an invisible one in the heap.
 */
const RELAY_QUEUE_MAX = 20_000;

/** Minimum gap between "dropped N events" reports, so the report cannot itself be the flood. */
const RELAY_DROP_REPORT_MS = 10_000;

export class PgLogRegistry implements LogRegistryIf {
  private initialized = false;
  private logs = new Map<string, ParsedRetention>();
  private pool: Pool;
  private listenPool: Pool;
  private tablePrefix: string;
  private relayUnsubscribe: RelayEventUnsubscriber | undefined;

  // Shared LISTEN connection — one connection for all log consumers
  private listenerConn?: PoolClient;
  private listenerReady?: Promise<void>;
  private listeners = new Map<string, Set<() => void>>();
  private listeningChannels = new Set<string>();

  /**
   * Which routing keys some log is bound to.
   *
   * An unbound event must not acquire a pooled connection or compete with log
   * appends and reads.
   */
  private bound = new BoundRoutingKeys(() => this.loadBoundKeys());

  /** Relayed events waiting to be written, drained in batches by `drainRelay`. */
  private relayQueue: { routingKey: string; payload: unknown }[] = [];
  private relayDraining = false;
  private relayDropped = 0;
  private relayDropReportedAt = 0;

  constructor(protected config: PgLogRegistryConfig) {
    const name = `${config.name}_logs`;
    if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
      throw new Error(`invalid table prefix: ${name}`);
    }
    this.tablePrefix = name;
    this.pool = config.pool;
    this.listenPool = config.listenPool ?? config.pool;
  }

  /** Create the logs metadata table and start listening for relay events. */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.query(`CREATE EXTENSION IF NOT EXISTS timescaledb;`);

    // `routing_patterns` mirrors the wildcard entries of `routing_keys` as compiled regexes,
    // so postgres runs a regex and never parses a pattern itself.
    await this.query(`
      CREATE TABLE IF NOT EXISTS ${this.logsTable} (
        id                VARCHAR(26) PRIMARY KEY,
        retention         TEXT NOT NULL,
        routing_keys      TEXT[] NOT NULL DEFAULT '{}',
        routing_patterns  TEXT[] NOT NULL DEFAULT '{}',
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await this.query(`
      CREATE INDEX IF NOT EXISTS ${this.logsTable}_routing_keys_idx
      ON ${this.logsTable}
      USING GIN (routing_keys);
    `);

    // Partial: the pattern branch of the relay lookup scans only logs that bound one.
    await this.query(`
      CREATE INDEX IF NOT EXISTS ${this.logsTable}_routing_patterns_idx
      ON ${this.logsTable} (id)
      WHERE routing_patterns <> '{}';
    `);

    await this.bound.refresh();
    await this.watchLogBindings();

    this.relayUnsubscribe = this.config.router.on((routingKey: string, payload: unknown) => {
      this.handleRelayEvent(routingKey, payload);
      return Promise.resolve();
    });

    this.initialized = true;
  }

  /** Every routing key any log is currently bound to. */
  private async loadBoundKeys(): Promise<string[]> {
    const result = await this.query<{ routing_key: string }>(
      `SELECT DISTINCT unnest(routing_keys) AS routing_key FROM ${this.logsTable}`,
    );
    return result.rows.map((row) => row.routing_key);
  }

  /**
   * Invalidate the bound set when the logs table changes underneath us.
   *
   * `touch`/`delete` keep it current for our own writes; this covers a writer we
   * do not control. Statement-level, payload unused — the handler reloads the
   * whole set, so one notification per statement is enough.
   */
  private async watchLogBindings(): Promise<void> {
    try {
      await this.query(`
        CREATE OR REPLACE FUNCTION ${this.logsTable}_notify_trigger()
        RETURNS trigger AS $$
        BEGIN
          PERFORM pg_notify('${this.bindingsChannel}', '');
          RETURN NULL;
        END;
        $$ LANGUAGE plpgsql;
      `);

      await this.query(`
        DROP TRIGGER IF EXISTS ${this.logsTable}_notify ON ${this.logsTable};
        CREATE TRIGGER ${this.logsTable}_notify
        AFTER INSERT OR UPDATE OR DELETE ON ${this.logsTable}
        FOR EACH STATEMENT EXECUTE FUNCTION ${this.logsTable}_notify_trigger();
      `);

      this.addListener(this.bindingsChannel, () => {
        this.bound.invalidate();
        void this.bound.refresh();
      });
      await this.ensureListener(this.bindingsChannel);
    } catch {
      // No invalidation channel means the cache cannot be trusted.
      this.bound.invalidate();
    }
  }

  /** Unsubscribe from relay events and clean up resources. */
  async dispose(): Promise<void> {
    if (this.listenerConn) {
      this.listenerConn.release();
      this.listenerConn = undefined;
      this.listenerReady = undefined;
      this.listeners.clear();
      this.listeningChannels.clear();
    }

    if (this.relayUnsubscribe) {
      this.relayUnsubscribe();
      this.relayUnsubscribe = undefined;
    }

    this.relayQueue = [];
  }

  /** Create or update a log's retention policy and routing keys. Returns true if a change was made. */
  async touch(id: string, opts: LogResourceOptions): Promise<boolean> {
    const retention = opts.retention ?? '';
    const routingKeys = opts.routingKeys ?? [];

    // Widened before the write so an event racing this upsert is not dropped.
    this.bound.add(routingKeys);

    await this.registerLog(id, retention);

    const parsed = parseRetention(retention);

    const result = await this.query(
      `
      INSERT INTO ${this.logsTable} (id, retention, routing_keys, routing_patterns)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (id) DO UPDATE
        SET
          retention = EXCLUDED.retention,
          routing_keys = EXCLUDED.routing_keys,
          routing_patterns = EXCLUDED.routing_patterns
      WHERE
        ${this.logsTable}.retention IS DISTINCT FROM EXCLUDED.retention
        OR
        ${this.logsTable}.routing_keys IS DISTINCT FROM EXCLUDED.routing_keys
        OR
        ${this.logsTable}.routing_patterns IS DISTINCT FROM EXCLUDED.routing_patterns
      `,
      [id, retention, routingKeys, routingPatternSources(routingKeys)],
    );

    const upserted = result.rowCount === 1;

    if (upserted) {
      const logTable = this.getLogTable(id);

      await this.query(`
        SELECT remove_retention_policy('${logTable}', if_exists => TRUE);
      `);

      if (parsed.type === 'duration') {
        await this.query(`
          SELECT add_retention_policy('${logTable}', INTERVAL '${parsed.interval}');
        `);
      }

      this.logs.set(id, parsed);
    }

    return upserted;
  }

  /** Open a log for reading/writing, returning a LogHandle. Creates the log if it does not exist. */
  async open(id: string, opts: LogResourceOptions, mode?: ResourceMode): Promise<LogHandle> {
    const { truncate } = await ensureResource(this, id, opts, mode);

    if (truncate) {
      await this.truncate(id);
    }

    const io: LogIO = {
      append: async (data: unknown, createdAt?: Date): Promise<LogEntryId> => {
        return await this.append(id, data, createdAt);
      },
      read: async (limit: number, startId?: LogEntryId, signal?: AbortSignal): Promise<LogEntry[] | null> => {
        return await this.read(id, limit, startId, signal);
      },
      seek: async (offset: number, whence: ResourceSeekMode, startId?: LogEntryId): Promise<LogEntryId> => {
        return await this.seek(id, offset, whence, startId);
      },
    };

    const rh = new LogHandle(id, opts, mode || 'r', this, io);
    await rh.init();

    return rh;
  }

  /** Check whether a log with the given id exists. */
  async exists(id: string): Promise<boolean> {
    const result = await this.query<{ exists: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1 FROM ${this.logsTable} WHERE id = $1
      ) AS exists
      `,
      [id],
    );

    return result.rows[0]?.exists ?? false;
  }

  /** Return metadata for a log including retention policy, entry count, and routing keys. */
  async stat(id: string): Promise<LogStat> {
    const result = await this.query<{ retention: string; routing_keys: string[] }>(
      `SELECT * FROM ${this.logsTable} WHERE id = $1`,
      [id],
    );

    if (result.rows.length === 0) {
      throw new Error(`no log found: ${id}`);
    }

    const logTable = this.getLogTable(id);
    const result2 = await this.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ${logTable}`,
    );

    return {
      retention: result.rows[0].retention,
      size: Number(result2.rows[0].count),
      routingKeys: result.rows[0].routing_keys,
    };
  }

  /** Extended stat; currently delegates to stat(). */
  async statX(id: string): Promise<LogStat> {
    return this.stat(id);
  }

  /** Delete a log and its backing table, trigger, and metadata row. */
  async delete(id: string): Promise<boolean> {
    const logTable = this.getLogTable(id);

    await this.query(`DROP TABLE IF EXISTS ${logTable} CASCADE`);
    await this.query(`DROP FUNCTION IF EXISTS ${logTable}_notify_trigger() CASCADE`);

    const result = await this.query(
      `DELETE FROM ${this.logsTable} WHERE id = $1`,
      [id],
    );

    // Reloaded rather than subtracted: another log may still bind a key this one
    // had, and a key removed in error is a silently dropped relay.
    await this.bound.refresh();

    return (result.rowCount ?? 0) > 0;
  }

  /** List all log ids as an async iterable. */
  async list(): Promise<AsyncIterable<string>> {
    const result = await this.query<{ id: string }>(`SELECT id FROM ${this.logsTable}`);

    return (async function* () {
      for (const row of result.rows) {
        yield row.id;
      }
    })();
  }

  /** Return the total number of registered logs. */
  async count(_id?: string): Promise<number> {
    const result = await this.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ${this.logsTable}`,
    );

    return Number(result.rows[0]?.count ?? '0');
  }

  private async truncate(id: string) {
    const logTable = this.getLogTable(id);
    await this.query(`TRUNCATE TABLE ${logTable} RESTART IDENTITY CASCADE`);
  }

  private async seek(id: string, offset: number, whence: ResourceSeekMode, startId?: LogEntryId): Promise<LogEntryId> {
    const logTable = this.getLogTable(id);
    let sql = '';
    // deno-lint-ignore no-explicit-any
    const params: any[] = [];

    switch (whence) {
      case ResourceSeekMode.Start: {
        params.push(offset);
        sql = `SELECT id FROM ${logTable} ORDER BY id ASC OFFSET $1 LIMIT 1`;
        break;
      }

      case ResourceSeekMode.Current: {
        if (startId === undefined) {
          throw new Error('current seek requires startId');
        }
        params.push(startId);
        params.push(offset);
        sql = `
          WITH ranked AS (
            SELECT id, ROW_NUMBER() OVER (ORDER BY id ASC) - 1 AS rn
            FROM ${logTable}
          ),
          base AS (
            SELECT rn FROM ranked WHERE id = $1
          )
          SELECT r.id
          FROM ranked r, base b
          WHERE r.rn = b.rn + $2
          LIMIT 1
        `;
        break;
      }

      case ResourceSeekMode.End: {
        params.push(Math.abs(offset));
        sql = `SELECT id FROM ${logTable} ORDER BY id DESC OFFSET $1 LIMIT 1`;
        break;
      }

      default:
        throw new Error(`invalid whence: ${whence}`);
    }

    const res = await this.query<{ id: LogEntryId }>(sql, params);

    if (res.rowCount === 0) {
      throw new Error(`seek failed: ${id} (offset=${offset}, whence=${whence}, startId=${startId})`);
    }

    return res.rows[0].id;
  }

  /**
   * Take a relayed event onto the queue. Deliberately does no I/O: the publisher does not
   * await this, so anything slow here accumulates instead of pushing back.
   */
  private handleRelayEvent(routingKey: string, payload: unknown): void {
    // Answered in memory so an unbound key never acquires a pooled connection
    // or competes with log appends and `tail -f` reads.
    if (!this.bound.has(routingKey)) {
      return;
    }

    if (this.relayQueue.length >= RELAY_QUEUE_MAX) {
      this.relayQueue.shift();
      this.relayDropped += 1;
    }

    this.relayQueue.push({ routingKey, payload });

    void this.drainRelay();
  }

  /**
   * Drain the queue in batches until it is empty.
   *
   * Self-tuning: whatever arrives during one flush is carried by the next, so a quiet system
   * writes one event per round trip and a busy one writes hundreds.
   */
  private async drainRelay(): Promise<void> {
    if (this.relayDraining) {
      return;
    }

    this.relayDraining = true;

    try {
      while (this.relayQueue.length > 0) {
        await this.flushRelayBatch(this.relayQueue.splice(0, RELAY_BATCH));
      }
    } catch (err) {
      // console, never `logger` — a logger call here publishes another relay event, which
      // fails the same way and logs again. The amplification would be unbounded.
      console.error('pg-log-registry: relay flush failed', err);
    } finally {
      this.relayDraining = false;
      this.reportRelayDrops();
    }
  }

  /** Write one batch: a single binding lookup, then one insert per destination log. */
  private async flushRelayBatch(batch: { routingKey: string; payload: unknown }[]): Promise<void> {
    const keys = [...new Set(batch.map((event) => event.routingKey))];

    // Two branches so each keeps its index — the array overlap uses the GIN index, the pattern
    // branch its partial one. Which of the batch's keys each row actually wants is decided in TS
    // below, against the same matcher the memory registry uses.
    const res = await this.query<{ id: string; routing_keys: string[] }>(
      `
      SELECT id, routing_keys FROM ${this.logsTable} WHERE routing_keys && $1
      UNION
      SELECT id, routing_keys FROM ${this.logsTable}
        WHERE routing_patterns <> '{}'
          AND EXISTS (SELECT 1 FROM unnest($1::text[]) AS k WHERE k ~ ANY(routing_patterns))
      `,
      [keys],
    );

    const targets = new Map<string, string[]>();

    for (const row of res.rows) {
      for (const key of keys) {
        if (!routingKeysMatch(row.routing_keys, key)) continue;
        const ids = targets.get(key);
        if (ids) ids.push(row.id);
        else targets.set(key, [row.id]);
      }
    }

    const byLog = new Map<string, string[]>();

    for (const event of batch) {
      for (const id of targets.get(event.routingKey) ?? []) {
        const rows = byLog.get(id);
        const data = JSON.stringify(event.payload);
        if (rows) rows.push(data);
        else byLog.set(id, [data]);
      }
    }

    for (const [id, rows] of byLog) {
      await this.appendMany(id, rows);
    }
  }

  /** Insert already-serialised entries into one log, oldest first. */
  private async appendMany(id: string, rows: string[]): Promise<void> {
    const logTable = this.getLogTable(id);

    await this.query(
      `INSERT INTO ${logTable} (data) SELECT value::jsonb FROM unnest($1::text[]) AS value`,
      [rows],
    );

    const parsed = this.logs.get(id);

    if (parsed?.type === 'count') {
      await this.trimToCount(logTable, parsed.limit);
    }
  }

  private reportRelayDrops(): void {
    if (this.relayDropped === 0) return;

    const now = Date.now();
    if (now - this.relayDropReportedAt < RELAY_DROP_REPORT_MS) return;

    console.warn(
      `pg-log-registry: dropped ${this.relayDropped} relayed events — the log writer is behind the publishers`,
    );
    this.relayDropped = 0;
    this.relayDropReportedAt = now;
  }

  private async append(id: string, data: unknown, createdAt?: Date): Promise<LogEntryId> {
    const logTable = this.getLogTable(id);

    const res = createdAt
      ? await this.query<{ id: LogEntryId }>(
        `INSERT INTO ${logTable} (data, created_at) VALUES ($1::jsonb, $2) RETURNING id`,
        [JSON.stringify(data), createdAt],
      )
      : await this.query<{ id: LogEntryId }>(
        `INSERT INTO ${logTable} (data) VALUES ($1::jsonb) RETURNING id`,
        [JSON.stringify(data)],
      );

    const entryId = res.rows[0].id;
    const parsed = this.logs.get(id);

    if (parsed?.type === 'count') {
      await this.trimToCount(logTable, parsed.limit);
    }

    return entryId;
  }

  /** Drop everything older than the newest `limit` entries. */
  private async trimToCount(logTable: string, limit: number): Promise<void> {
    await this.query(`
      DELETE FROM ${logTable}
      WHERE id <= (
        SELECT id FROM ${logTable}
        ORDER BY id DESC
        OFFSET ${limit}
        LIMIT 1
      )
    `);
  }

  private async read(id: string, limit: number, startId?: LogEntryId, signal?: AbortSignal): Promise<LogEntry[] | null> {
    const logTable = this.getLogTable(id);

    // deno-lint-ignore no-explicit-any
    const params: any[] = [];
    let whereClause = '';

    if (startId !== undefined && startId > 0) {
      params.push(startId);
      whereClause = `WHERE id > $${params.length}`;
    }

    params.push(limit);

    const query = `
      SELECT id, data, created_at
      FROM ${logTable}
      ${whereClause}
      ORDER BY id ASC
      LIMIT $${params.length}
    `;

    // Initial query
    const res = await this.query<{ id: LogEntryId; data: unknown; created_at: Date }>(query, params);

    if (res.rows.length > 0 || !signal) {
      return res.rows.map((r) => ({
        id: r.id,
        data: r.data,
        createdAt: r.created_at,
      }));
    }

    // Blocking mode: wait via shared listener
    const channel = this.getLogChannel(logTable);
    await this.ensureListener(channel);

    return await new Promise<LogEntry[] | null>((resolve) => {
      const tryRead = async () => {
        try {
          const inner = await this.query<{ id: LogEntryId; data: unknown; created_at: Date }>(query, params);

          if (inner.rows.length > 0) {
            cleanup();
            resolve(
              inner.rows.map((r) => ({
                id: r.id,
                data: r.data,
                createdAt: r.created_at,
              })),
            );
          }
          // If still no rows, keep waiting for next notification
        } catch {
          cleanup();
          resolve(null);
        }
      };

      const onAbort = () => {
        cleanup();
        resolve(null);
      };

      const removeListener = this.addListener(channel, tryRead);

      const cleanup = () => {
        removeListener();
        signal.removeEventListener('abort', onAbort);
      };

      signal.addEventListener('abort', onAbort, { once: true });

      if (signal.aborted) {
        onAbort();
        return;
      }

      // Immediate retry to catch inserts between initial query and listener registration
      tryRead();
    });
  }

  private ensureListener(channel: string): Promise<void> {
    if (!this.listenerReady) {
      this.listenerReady = (async () => {
        const conn = await this.listenPool.connect();
        conn.on('notification', (msg: { channel: string }) => {
          const callbacks = this.listeners.get(msg.channel);
          if (callbacks) {
            for (const cb of callbacks) cb();
          }
        });
        this.listenerConn = conn;
      })();
    }

    const ready = this.listenerReady;

    if (this.listeningChannels.has(channel)) {
      return ready;
    }

    return ready.then(async () => {
      if (!this.listeningChannels.has(channel)) {
        await this.listenerConn!.query(`LISTEN ${channel}`);
        this.listeningChannels.add(channel);
      }
    });
  }

  private addListener(channel: string, callback: () => void): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(callback);
    return () => {
      set!.delete(callback);
      if (set!.size === 0) this.listeners.delete(channel);
    };
  }

  private async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) {
    // The pool directly, with no client or mutex of the registry's own, so an
    // append, a read or a relay flush never waits behind another log's query.
    return await this.pool.query<T>(sql, params);
  }

  private getLogTable(id: string): string {
    return `${this.tablePrefix}_${id}`;
  }

  /**
   * Channel a log's insert trigger notifies on.
   *
   * A hash of the table name, so its length does not grow with the registry name and the
   * log id: `pg_notify` rejects a channel of 64 bytes or more, and LISTEN
   * truncates it.
   */
  private getLogChannel(logTable: string): string {
    return `log_${createHash('md5').update(logTable.toLowerCase()).digest('hex')}`;
  }

  private get logsTable() {
    return `${this.tablePrefix}`;
  }

  /** Channel the logs-table trigger notifies on when a routing-key binding changes. */
  private get bindingsChannel() {
    return `${this.tablePrefix}_bind`;
  }

  private async registerLog(id: string, retention?: string): Promise<void> {
    if (this.logs.has(id)) {
      return;
    }

    const parsed = parseRetention(retention ?? '');
    const logTable = this.getLogTable(id);

    await this.query(`
      CREATE TABLE IF NOT EXISTS ${logTable} (
        id            BIGSERIAL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        data          JSONB,
        PRIMARY KEY (id, created_at)
      )
    `);

    await this.query(`SELECT create_hypertable('${logTable}', 'created_at', if_not_exists => true)`);
    await this.query(`SELECT remove_retention_policy('${logTable}', if_exists => TRUE)`);

    if (parsed.type === 'duration') {
      await this.query(`SELECT add_retention_policy('${logTable}', INTERVAL '${parsed.interval}')`);
    }

    await this.query(`
      CREATE OR REPLACE FUNCTION ${logTable}_notify_trigger()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_notify('${this.getLogChannel(logTable)}', NEW.id::text);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await this.query(`
      DROP TRIGGER IF EXISTS ${logTable}_notify ON ${logTable};
      CREATE TRIGGER ${logTable}_notify
      AFTER INSERT ON ${logTable}
      FOR EACH ROW EXECUTE FUNCTION ${logTable}_notify_trigger()
    `);

    this.logs.set(id, parsed);
  }
}
