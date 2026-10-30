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
 * The table a log's entries live in, shared by every log with the same retention.
 *
 * `count` logs share a plain table, trimmed per log after each append. Every other class is a
 * hypertable whose expired chunks TimescaleDB drops whole; `compressAfter` is set where the data
 * stays long enough for compression by log to pay.
 */
type EntryClass = {
  table: string;
  hypertable: boolean;
  /** Seconds per chunk. */
  chunk?: number;
  /** Seconds after which a chunk is dropped; unset keeps it. */
  dropAfter?: number;
  /** Seconds after which a chunk is compressed; unset never compresses. */
  compressAfter?: number;
};

/** A registered log: its key in the entry tables and where its entries are. */
type Log = { key: number; retention: ParsedRetention; cls: EntryClass };

const DAY = 24 * 60 * 60;

/** Chunk length for logs kept forever. Long chunks hold enough of each log to read and compress it as one run. */
const FOREVER_CHUNK = 90 * DAY;

/** How long a closed chunk waits before it is compressed, for late and backdated appends. */
const COMPRESS_DELAY = 7 * DAY;

/** A duration class is compressed only when its data is kept at least this long. */
const COMPRESS_MIN_RETENTION = 30 * DAY;

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

/**
 * Logs in PostgreSQL: a row per log in `{name}_logs`, its entries in one table per retention class.
 *
 * Entry ids come from one sequence shared by all logs, so they increase within each log and a
 * cursor is the last id read. Blocking readers are woken by this registry's own appends, not by
 * `pg_notify`: a commit that notifies cannot be group-committed, which caps every writer at once
 * (ein/core#811). Entries written to these tables by anything else are seen only by a reader's
 * next read.
 */
export class PgLogRegistry implements LogRegistryIf {
  private initialized = false;
  private logs = new Map<string, Log>();
  private pool: Pool;
  private listenPool: Pool;
  private tablePrefix: string;
  private relayUnsubscribe: RelayEventUnsubscriber | undefined;

  /** Entry tables created or found, by table name. */
  private classes = new Map<string, Promise<void>>();
  /** Seconds in a duration retention, by its text. */
  private durations = new Map<string, number>();

  /** Blocking readers waiting for an append, by log id. */
  private waiters = new Map<string, Set<() => void>>();

  // Shared LISTEN connection, for changes to the logs table made by another writer
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

  /** Create the logs table and the entry id sequence, and start listening for relay events. */
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
        key               INTEGER GENERATED ALWAYS AS IDENTITY UNIQUE,
        retention         TEXT NOT NULL,
        routing_keys      TEXT[] NOT NULL DEFAULT '{}',
        routing_patterns  TEXT[] NOT NULL DEFAULT '{}',
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Owned by the logs table so that dropping the registry's tables drops it too.
    await this.query(`CREATE SEQUENCE IF NOT EXISTS ${this.entryIdSeq} OWNED BY ${this.logsTable}.id`);

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

  /**
   * Create or update a log's retention policy and routing keys. Returns true if a change was made.
   *
   * A retention in another class moves the log's entries to that class's table.
   */
  async touch(id: string, opts: LogResourceOptions): Promise<boolean> {
    const retention = opts.retention ?? '';
    const routingKeys = opts.routingKeys ?? [];
    const patterns = routingPatternSources(routingKeys);

    // Widened before the write so an event racing this upsert is not dropped.
    this.bound.add(routingKeys);

    const parsed = parseRetention(retention);
    const cls = await this.classOf(parsed);
    await this.ensureClass(cls);

    const result = await this.transaction(async (client) => {
      const inserted = await client.query<{ key: number }>(
        `
        INSERT INTO ${this.logsTable} (id, retention, routing_keys, routing_patterns)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO NOTHING
        RETURNING key
        `,
        [id, retention, routingKeys, patterns],
      );

      if (inserted.rows.length === 1) {
        return { key: inserted.rows[0].key, changed: true };
      }

      const current = await client.query<{ key: number; retention: string }>(
        `SELECT key, retention FROM ${this.logsTable} WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const { key, retention: before } = current.rows[0];

      const updated = await client.query(
        `
        UPDATE ${this.logsTable}
        SET retention = $2, routing_keys = $3, routing_patterns = $4
        WHERE id = $1 AND (
          retention IS DISTINCT FROM $2
          OR routing_keys IS DISTINCT FROM $3
          OR routing_patterns IS DISTINCT FROM $4
        )
        `,
        [id, retention, routingKeys, patterns],
      );

      const from = await this.classOf(parseRetention(before));

      if (from.table !== cls.table) {
        await this.ensureClass(from);
        await client.query(
          `INSERT INTO ${cls.table} (log_key, id, created_at, data) SELECT log_key, id, created_at, data FROM ${from.table} WHERE log_key = $1`,
          [key],
        );
        await client.query(`DELETE FROM ${from.table} WHERE log_key = $1`, [key]);
      }

      return { key, changed: (updated.rowCount ?? 0) > 0 };
    });

    const log = { key: result.key, retention: parsed, cls };
    this.logs.set(id, log);

    if (result.changed && parsed.type === 'count') {
      await this.trimToCount(log, parsed.limit);
    }

    return result.changed;
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
      `SELECT retention, routing_keys FROM ${this.logsTable} WHERE id = $1`,
      [id],
    );

    if (result.rows.length === 0) {
      throw new Error(`no log found: ${id}`);
    }

    const log = await this.resolve(id);
    const result2 = await this.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ${log.cls.table} WHERE log_key = $1`,
      [log.key],
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

  /** Delete a log: its entries and its row. Readers blocked on it return empty. */
  async delete(id: string): Promise<boolean> {
    let log: Log | undefined;
    try {
      log = await this.resolve(id);
    } catch {
      log = undefined;
    }

    const deleted = await this.transaction(async (client) => {
      if (log) {
        await client.query(`DELETE FROM ${log.cls.table} WHERE log_key = $1`, [log.key]);
      }
      const result = await client.query(`DELETE FROM ${this.logsTable} WHERE id = $1`, [id]);
      return (result.rowCount ?? 0) > 0;
    });

    this.logs.delete(id);
    this.wake(id);

    // Reloaded rather than subtracted: another log may still bind a key this one
    // had, and a key removed in error is a silently dropped relay.
    await this.bound.refresh();

    return deleted;
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
    const log = await this.resolve(id);
    await this.transaction((client) => client.query(`DELETE FROM ${log.cls.table} WHERE log_key = $1`, [log.key]));
  }

  /** The id `offset` entries from `whence`: the first entry, the cursor, or past the last entry. */
  private async seek(id: string, offset: number, whence: ResourceSeekMode, startId?: LogEntryId): Promise<LogEntryId> {
    const { key, cls } = await this.resolve(id);
    const t = cls.table;
    let sql: string;
    let params: unknown[];

    switch (whence) {
      case ResourceSeekMode.Start: {
        sql = `SELECT id FROM ${t} WHERE log_key = $1 ORDER BY id ASC OFFSET $2 LIMIT 1`;
        params = [key, offset];
        break;
      }

      case ResourceSeekMode.Current: {
        if (startId === undefined) {
          throw new Error('current seek requires startId');
        }
        if (offset === 0) {
          sql = `SELECT id FROM ${t} WHERE log_key = $1 AND id = $2`;
          params = [key, startId];
        } else if (offset > 0) {
          sql = `SELECT id FROM ${t} WHERE log_key = $1 AND id > $2 ORDER BY id ASC OFFSET $3 LIMIT 1`;
          params = [key, startId, offset - 1];
        } else {
          sql = `SELECT id FROM ${t} WHERE log_key = $1 AND id < $2 ORDER BY id DESC OFFSET $3 LIMIT 1`;
          params = [key, startId, -offset - 1];
        }
        break;
      }

      case ResourceSeekMode.End: {
        sql = `SELECT id FROM ${t} WHERE log_key = $1 ORDER BY id DESC OFFSET $2 LIMIT 1`;
        params = [key, Math.abs(offset)];
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
    const log = await this.resolve(id);

    await this.query(
      `
      INSERT INTO ${log.cls.table} (log_key, id, data)
      SELECT $1, nextval('${this.entryIdSeq}'), value::jsonb FROM unnest($2::text[]) AS value
      `,
      [log.key, rows],
    );

    if (log.retention.type === 'count') {
      await this.trimToCount(log, log.retention.limit);
    }

    this.wake(id);
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
    const log = await this.resolve(id);

    const res = await this.query<{ id: LogEntryId }>(
      `
      INSERT INTO ${log.cls.table} (log_key, id, created_at, data)
      VALUES ($1, nextval('${this.entryIdSeq}'), COALESCE($2, now()), $3::jsonb)
      RETURNING id
      `,
      [log.key, createdAt ?? null, JSON.stringify(data)],
    );

    if (log.retention.type === 'count') {
      await this.trimToCount(log, log.retention.limit);
    }

    this.wake(id);

    return res.rows[0].id;
  }

  /** Drop everything of one log older than its newest `limit` entries. */
  private async trimToCount(log: Log, limit: number): Promise<void> {
    await this.query(
      `
      DELETE FROM ${log.cls.table}
      WHERE log_key = $1 AND id <= (
        SELECT id FROM ${log.cls.table}
        WHERE log_key = $1
        ORDER BY id DESC
        OFFSET $2
        LIMIT 1
      )
      `,
      [log.key, limit],
    );
  }

  private async fetch(id: string, limit: number, startId?: LogEntryId): Promise<LogEntry[]> {
    const { key, cls } = await this.resolve(id);

    const res = await this.query<{ id: LogEntryId; data: unknown; created_at: Date }>(
      `
      SELECT id, data, created_at
      FROM ${cls.table}
      WHERE log_key = $1 AND id > $2
      ORDER BY id ASC
      LIMIT $3
      `,
      [key, startId !== undefined && startId > 0 ? startId : 0, limit],
    );

    return res.rows.map((r) => ({ id: r.id, data: r.data, createdAt: r.created_at }));
  }

  private async read(id: string, limit: number, startId?: LogEntryId, signal?: AbortSignal): Promise<LogEntry[] | null> {
    const entries = await this.fetch(id, limit, startId);

    if (entries.length > 0 || !signal) {
      return entries;
    }

    // Blocking mode: wait for this registry's next append to the log
    return await new Promise<LogEntry[] | null>((resolve) => {
      const tryRead = async () => {
        try {
          const inner = await this.fetch(id, limit, startId);

          if (inner.length > 0) {
            cleanup();
            resolve(inner);
          }
          // If still no rows, keep waiting for the next append
        } catch {
          cleanup();
          resolve(null);
        }
      };

      const onAbort = () => {
        cleanup();
        resolve(null);
      };

      let set = this.waiters.get(id);
      if (!set) {
        set = new Set();
        this.waiters.set(id, set);
      }
      set.add(tryRead);

      const cleanup = () => {
        set.delete(tryRead);
        if (set.size === 0 && this.waiters.get(id) === set) this.waiters.delete(id);
        signal.removeEventListener('abort', onAbort);
      };

      signal.addEventListener('abort', onAbort, { once: true });

      if (signal.aborted) {
        onAbort();
        return;
      }

      // Immediate retry to catch an append between the first read and registering
      tryRead();
    });
  }

  /** Let every reader blocked on this log read again. */
  private wake(id: string): void {
    const set = this.waiters.get(id);
    if (!set) return;
    for (const cb of [...set]) cb();
  }

  /** The log's key and class, from memory or from the logs table. */
  private async resolve(id: string): Promise<Log> {
    const cached = this.logs.get(id);
    if (cached) return cached;

    const res = await this.query<{ key: number; retention: string }>(
      `SELECT key, retention FROM ${this.logsTable} WHERE id = $1`,
      [id],
    );

    if (res.rows.length === 0) {
      throw new Error(`no log found: ${id}`);
    }

    const retention = parseRetention(res.rows[0].retention);
    const cls = await this.classOf(retention);
    await this.ensureClass(cls);

    const log = { key: res.rows[0].key, retention, cls };
    this.logs.set(id, log);
    return log;
  }

  /**
   * The entry table for a retention.
   *
   * A duration's chunks are a quarter of it, between an hour and the forever chunk, so a dropped
   * chunk keeps nothing much past the retention.
   */
  private async classOf(retention: ParsedRetention): Promise<EntryClass> {
    switch (retention.type) {
      case 'forever':
        return { table: this.entryTable('forever'), hypertable: true, chunk: FOREVER_CHUNK, compressAfter: COMPRESS_DELAY };
      case 'count':
        return { table: this.entryTable('count'), hypertable: false };
      case 'duration': {
        const seconds = await this.durationSeconds(retention.interval);
        const chunk = Math.min(FOREVER_CHUNK, Math.max(60 * 60, Math.round(seconds / 4)));
        return {
          table: this.entryTable(`d${seconds}`),
          hypertable: true,
          chunk,
          dropAfter: seconds,
          compressAfter: seconds >= COMPRESS_MIN_RETENTION ? chunk : undefined,
        };
      }
    }
  }

  /** Seconds in an interval, as PostgreSQL reads it. */
  private async durationSeconds(interval: string): Promise<number> {
    const known = this.durations.get(interval);
    if (known !== undefined) return known;

    const res = await this.query<{ seconds: string }>(
      `SELECT extract(epoch FROM $1::interval)::bigint AS seconds`,
      [interval],
    );
    const seconds = Number(res.rows[0].seconds);
    if (!(seconds > 0)) {
      throw new Error(`invalid retention: ${interval}`);
    }

    this.durations.set(interval, seconds);
    return seconds;
  }

  /** Create a class's table and its TimescaleDB policies once per registry. */
  private ensureClass(cls: EntryClass): Promise<void> {
    let ready = this.classes.get(cls.table);
    if (!ready) {
      ready = this.createClass(cls);
      this.classes.set(cls.table, ready);
      ready.catch(() => this.classes.delete(cls.table));
    }
    return ready;
  }

  private async createClass(cls: EntryClass): Promise<void> {
    const t = cls.table;

    if (!cls.hypertable) {
      await this.query(`
        CREATE TABLE IF NOT EXISTS ${t} (
          log_key     INTEGER NOT NULL,
          id          BIGINT NOT NULL,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          data        JSONB,
          PRIMARY KEY (log_key, id)
        )
      `);
      return;
    }

    // No unique index: a hypertable's would have to include `created_at`. Ids are unique by
    // coming from one sequence.
    await this.query(`
      CREATE TABLE IF NOT EXISTS ${t} (
        log_key     INTEGER NOT NULL,
        id          BIGINT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        data        JSONB
      )
    `);

    // Without the default index on created_at: nothing reads by time alone, and it would be the
    // larger part of the table's indexes.
    await this.query(
      `SELECT create_hypertable($1::regclass, 'created_at', chunk_time_interval => make_interval(secs => $2), create_default_indexes => false, if_not_exists => true)`,
      [t, cls.chunk],
    );
    await this.query(`CREATE INDEX IF NOT EXISTS ${t}_log_id ON ${t} (log_key, id)`);

    if (cls.dropAfter !== undefined) {
      await this.query(
        `SELECT add_retention_policy($1::regclass, make_interval(secs => $2), if_not_exists => true)`,
        [t, cls.dropAfter],
      );
    }

    if (cls.compressAfter !== undefined) {
      // Settings cannot change once a chunk is compressed, so they are set only the first time.
      const res = await this.query<{ enabled: boolean }>(
        `SELECT compression_enabled AS enabled FROM timescaledb_information.hypertables
         WHERE hypertable_schema = current_schema() AND hypertable_name = $1`,
        [t],
      );
      if (!res.rows[0]?.enabled) {
        await this.query(`
          ALTER TABLE ${t} SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'log_key',
            timescaledb.compress_orderby = 'id'
          )
        `);
      }
      await this.query(
        `SELECT add_compression_policy($1::regclass, make_interval(secs => $2), if_not_exists => true)`,
        [t, cls.compressAfter],
      );
    }
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

  /**
   * Run `fn` in a transaction on one client.
   *
   * A write that reaches compressed chunks decompresses them, and TimescaleDB refuses one that
   * decompresses more than its per-transaction limit; these writes take a whole log, so the
   * limit is lifted for them.
   */
  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0`);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private entryTable(cls: string): string {
    return `${this.tablePrefix}_e_${cls}`;
  }

  private get logsTable() {
    return `${this.tablePrefix}`;
  }

  private get entryIdSeq() {
    return `${this.tablePrefix}_entry_id`;
  }

  /** Channel the logs-table trigger notifies on when a routing-key binding changes. */
  private get bindingsChannel() {
    return `${this.tablePrefix}_bind`;
  }
}
