/**
 * TrackRegistry — tracks in PostgreSQL with PostGIS.
 *
 * One row per fix in a single shared points table, keyed `(track_id, ts)`. That
 * key is what lets a backdated import, a duplicate upload and an out-of-order
 * live feed all land correctly.
 *
 * Reads are answered by the index rather than by scanning: a GiST index on the
 * planar geometry for the viewport, `(track_id, ts)` for a time window. Level of
 * detail is `ST_Simplify` over a per-day `ST_MakeLine`, so a zoomed-out map is
 * cheap in postgres *and* on the wire — the vertices that cannot be seen are
 * never sent.
 */
import type { Pool, PoolClient } from 'pg';
import type { RelayEventUnsubscriber, RouterManagerIf } from '../../managers/router/mod.ts';
import { BoundRoutingKeys } from '../bound-routing-keys.ts';
import { routingPatternSources } from '../routing-key-match.ts';
import { ensureResource, ResourceMode } from '../types.ts';
import { countPoints, DEFAULT_MARGIN, normalizePoints, summarize } from './lib.ts';
import { capSegments, expandBounds, toSegments } from './segment.ts';
import { TrackHandle } from './track-handle.ts';
import { TrackIO, TrackPoint, TrackRange, TrackReadOptions, TrackReadResult, TrackRegistryIf, TrackResourceOptions, TrackStat, TrackSummary } from './types.ts';

type TrackRegistryConfig = {
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

/** Query function bound to the transaction's client. */
type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }>;

type SummaryRow = {
  points: number;
  first_ts: Date | null;
  last_ts: Date | null;
  north: number | null;
  south: number | null;
  east: number | null;
  west: number | null;
};

type PointRow = {
  ts: Date;
  lat: number;
  lng: number;
  alt: number | null;
  speed: number | null;
  course: number | null;
};

export class TrackRegistry implements TrackRegistryIf {
  private initialized = false;
  private pool: Pool;
  private listenPool: Pool;
  private tablePrefix: string;
  private relayUnsubscribe: RelayEventUnsubscriber | undefined;

  // Shared LISTEN connection, so every follower shares one connection
  private listenerConn?: PoolClient;
  private listenerReady?: Promise<void>;
  private listeners = new Map<string, Set<() => void>>();
  private listeningChannels = new Set<string>();

  private bound = new BoundRoutingKeys(() => this.loadBoundKeys());

  constructor(private config: TrackRegistryConfig) {
    const name = `${config.name}_tracks`;
    if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
      throw new Error(`invalid table prefix: ${name}`);
    }
    this.tablePrefix = name;
    this.pool = config.pool;
    this.listenPool = config.listenPool ?? config.pool;
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.query(`CREATE EXTENSION IF NOT EXISTS postgis;`);

    // The summary lives on this row rather than being aggregated per call: `ls
    // /tracks` asks every track how big it is, and that must not touch the
    // points table.
    await this.query(`
      CREATE TABLE IF NOT EXISTS ${this.tracksTable} (
        id                VARCHAR(26) PRIMARY KEY,
        routing_keys      TEXT[] NOT NULL DEFAULT '{}',
        routing_patterns  TEXT[] NOT NULL DEFAULT '{}',
        points            BIGINT NOT NULL DEFAULT 0,
        first_ts          TIMESTAMPTZ,
        last_ts           TIMESTAMPTZ,
        north             DOUBLE PRECISION,
        south             DOUBLE PRECISION,
        east              DOUBLE PRECISION,
        west              DOUBLE PRECISION,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await this.query(`
      CREATE INDEX IF NOT EXISTS ${this.tracksTable}_routing_keys_idx
      ON ${this.tracksTable} USING GIN (routing_keys)
    `);

    // `routing_patterns` holds the compiled regex of each wildcard binding in `routing_keys`;
    // its index is partial, so the pattern branch below reads only the tracks that bound one.
    await this.query(`
      CREATE INDEX IF NOT EXISTS ${this.tracksTable}_routing_patterns_idx
      ON ${this.tracksTable} (id) WHERE routing_patterns <> '{}'
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS ${this.pointsTable} (
        track_id  VARCHAR(26) NOT NULL REFERENCES ${this.tracksTable}(id) ON DELETE CASCADE,
        ts        TIMESTAMPTZ NOT NULL,
        geog      GEOGRAPHY(POINT, 4326) NOT NULL,
        alt       DOUBLE PRECISION,
        speed     DOUBLE PRECISION,
        course    DOUBLE PRECISION,
        PRIMARY KEY (track_id, ts)
      )
    `);

    // Viewport reads run in planar lon/lat space — a geography envelope cannot
    // span 180+ degrees of longitude.
    await this.query(`
      CREATE INDEX IF NOT EXISTS ${this.pointsTable}_geom_idx
      ON ${this.pointsTable} USING GIST (((geog::geometry)))
    `);

    await this.query(`
      CREATE OR REPLACE FUNCTION ${this.pointsTable}_notify_trigger()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_notify('${this.pointsTable.toLowerCase()}_channel', NEW.track_id);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await this.query(`
      DROP TRIGGER IF EXISTS ${this.pointsTable}_notify ON ${this.pointsTable};
      CREATE TRIGGER ${this.pointsTable}_notify
      AFTER INSERT ON ${this.pointsTable}
      FOR EACH ROW EXECUTE FUNCTION ${this.pointsTable}_notify_trigger()
    `);

    await this.bound.refresh();

    this.relayUnsubscribe = this.config.router.on(async (routingKey: string, payload: unknown) => {
      await this.handleRelayEvent(routingKey, payload);
    });

    this.initialized = true;
  }

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
  }

  async touch(id: string, opts: TrackResourceOptions): Promise<boolean> {
    const routingKeys = opts.routingKeys ?? [];

    // Widened before the write so an event racing this upsert is not dropped.
    this.bound.add(routingKeys);

    const result = await this.query(
      `
      INSERT INTO ${this.tracksTable} (id, routing_keys, routing_patterns)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO UPDATE SET
        routing_keys = EXCLUDED.routing_keys,
        routing_patterns = EXCLUDED.routing_patterns
      WHERE ${this.tracksTable}.routing_keys IS DISTINCT FROM EXCLUDED.routing_keys
        OR ${this.tracksTable}.routing_patterns IS DISTINCT FROM EXCLUDED.routing_patterns
      `,
      [id, routingKeys, routingPatternSources(routingKeys)],
    );

    return result.rowCount === 1;
  }

  async open(id: string, opts: TrackResourceOptions, mode?: ResourceMode): Promise<TrackHandle> {
    const { truncate } = await ensureResource(this, id, opts, mode);

    if (truncate) {
      await this.deletePoints(id, {});
    }

    const io: TrackIO = {
      append: (points: TrackPoint[]) => this.appendPoints(id, points),
      page: (afterTs, limit, signal) => this.pagePoints(id, afterTs, limit, signal),
      read: (readOpts) => this.readPoints(id, readOpts),
      remove: (range) => this.deletePoints(id, range),
      summary: () => this.summary(id),
    };

    const rh = new TrackHandle(id, opts, mode || 'r', this, io);
    await rh.init();

    return rh;
  }

  async exists(id: string): Promise<boolean> {
    const result = await this.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${this.tracksTable} WHERE id = $1) AS exists`,
      [id],
    );

    return result.rows[0]?.exists ?? false;
  }

  async stat(id: string): Promise<TrackStat> {
    const row = await this.summaryRow(id);
    const summary = toSummary(row);

    return { ...summary, size: summary.points, routingKeys: row.routing_keys };
  }

  async statX(id: string): Promise<TrackStat> {
    return this.stat(id);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.query(`DELETE FROM ${this.tracksTable} WHERE id = $1`, [id]);

    // Reloaded rather than subtracted: another track may still bind a key this
    // one had, and a key removed in error is a silently dropped relay.
    await this.bound.refresh();

    return (result.rowCount ?? 0) > 0;
  }

  async list(): Promise<AsyncIterable<string>> {
    const result = await this.query<{ id: string }>(`SELECT id FROM ${this.tracksTable}`);

    return (async function* () {
      for (const row of result.rows) {
        yield row.id;
      }
    })();
  }

  async count(_id?: string): Promise<number> {
    const result = await this.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${this.tracksTable}`);
    return Number(result.rows[0]?.count ?? '0');
  }

  /**
   * Insert points, ignoring timestamps already present, and fold them into the
   * summary in the same transaction so the two cannot drift.
   *
   * A whole GPX file arrives in one call, so the points travel as six parallel
   * arrays and are unnested into rows in postgres. A tuple list does not survive
   * the size: a bind message counts its parameters in 16 bits, so past ~10 900
   * fixes the count wraps and postgres reports a mismatch against a number
   * nobody asked for. This way the statement takes seven parameters whatever
   * the file weighs.
   */
  async appendPoints(id: string, points: TrackPoint[]): Promise<number> {
    const incoming = normalizePoints(points);

    if (incoming.length === 0) return 0;

    const summary = summarize(incoming);

    const ts = incoming.map((point) => point.ts);
    const lng = incoming.map((point) => point.lng);
    const lat = incoming.map((point) => point.lat);
    const alt = incoming.map((point) => point.alt ?? null);
    const speed = incoming.map((point) => point.speed ?? null);
    const course = incoming.map((point) => point.course ?? null);

    return await this.transaction(async (q) => {
      // Both the track row lock and the existence check, in one statement.
      //
      // The lock is what fixes the order in which the two writers take their
      // locks — this one and `deletePoints` — so they queue instead of
      // deadlocking: without it an append holding uncommitted point rows would
      // wait for the track row while a delete holding the track row waited for
      // those points. Being the existence check too, it leaves no window where
      // the track is dropped between the check and the insert.
      const track = await q(`SELECT 1 FROM ${this.tracksTable} WHERE id = $1 FOR UPDATE`, [id]);
      if ((track.rowCount ?? 0) === 0) throw new Error(`no track found: ${id}`);

      const inserted = await q(
        `
        INSERT INTO ${this.pointsTable} (track_id, ts, geog, alt, speed, course)
        SELECT $1, point.ts, ST_SetSRID(ST_MakePoint(point.lng, point.lat), 4326)::geography, point.alt, point.speed, point.course
        FROM unnest($2::timestamptz[], $3::double precision[], $4::double precision[], $5::double precision[], $6::double precision[], $7::double precision[])
          AS point(ts, lng, lat, alt, speed, course)
        ON CONFLICT (track_id, ts) DO NOTHING
        `,
        [id, ts, lng, lat, alt, speed, course],
      );

      const written = inserted.rowCount ?? 0;

      if (written > 0) {
        await q(
          `
          UPDATE ${this.tracksTable} SET
            points   = points + $2,
            first_ts = LEAST(first_ts, $3::timestamptz),
            last_ts  = GREATEST(last_ts, $4::timestamptz),
            north    = GREATEST(north, $5::double precision),
            south    = LEAST(south, $6::double precision),
            east     = GREATEST(east, $7::double precision),
            west     = LEAST(west, $8::double precision)
          WHERE id = $1
          `,
          [
            id,
            written,
            summary.firstTs,
            summary.lastTs,
            summary.bbox?.north,
            summary.bbox?.south,
            summary.bbox?.east,
            summary.bbox?.west,
          ],
        );
      }

      return written;
    });
  }

  /**
   * The viewport read.
   *
   * With a tolerance, postgres builds one `LINESTRINGM` per UTC day out of the
   * matching fixes and simplifies it, so what crosses the wire is already
   * drawable. The M ordinate carries the fix time, which is what lets the day
   * and pause split happen afterwards; `alt`/`speed`/`course` are not vertices
   * of a line and do not survive a simplified read.
   *
   * A day holding a single fix is kept: `ST_Simplify` with `preserveCollapsed`
   * returns a one-vertex line unchanged.
   */
  async readPoints(id: string, opts: TrackReadOptions = {}): Promise<TrackReadResult> {
    const values: unknown[] = [id];
    const where: string[] = [`track_id = $1`];

    if (opts.from !== undefined) {
      values.push(opts.from);
      where.push(`ts >= $${values.length}::timestamptz`);
    }

    if (opts.to !== undefined) {
      values.push(opts.to);
      where.push(`ts < $${values.length}::timestamptz`);
    }

    if (opts.bounds) {
      const box = expandBounds(opts.bounds, opts.margin ?? DEFAULT_MARGIN);
      values.push(box.west, box.south, box.east, box.north);
      where.push(
        `geog::geometry && ST_MakeEnvelope($${values.length - 3}::double precision, $${values.length - 2}::double precision, ` +
          `$${values.length - 1}::double precision, $${values.length}::double precision, 4326)`,
      );
    }

    const tolerance = opts.tolerance ?? 0;
    let points: TrackPoint[];

    if (tolerance > 0) {
      values.push(tolerance);

      const result = await this.query<{ lat: number; lng: number; m: number }>(
        `
        WITH lines AS (
          SELECT
            (ts AT TIME ZONE 'UTC')::date AS day,
            ST_MakeLine(
              ST_MakePointM(ST_X(geog::geometry), ST_Y(geog::geometry), EXTRACT(EPOCH FROM ts)) ORDER BY ts
            ) AS line
          FROM ${this.pointsTable}
          WHERE ${where.join(' AND ')}
          GROUP BY 1
        )
        SELECT ST_Y(dp.geom) AS lat, ST_X(dp.geom) AS lng, ST_M(dp.geom) AS m
        FROM lines l
        CROSS JOIN LATERAL ST_DumpPoints(ST_Simplify(l.line, $${values.length}::double precision, true)) dp
        ORDER BY l.day, dp.path[1]
        `,
        values,
      );

      points = result.rows.map((row) => ({
        lat: row.lat,
        lng: row.lng,
        ts: new Date(row.m * 1000).toISOString(),
      }));
    } else {
      const result = await this.query<PointRow>(
        `
        SELECT ts, ST_Y(geog::geometry) AS lat, ST_X(geog::geometry) AS lng, alt, speed, course
        FROM ${this.pointsTable}
        WHERE ${where.join(' AND ')}
        ORDER BY ts
        `,
        values,
      );

      points = result.rows.map(fromRow);
    }

    // Simplification already happened in SQL, so this is only the day/pause cut.
    const full = toSegments(points, 0);
    const fullCount = countPoints(full);

    const segments = opts.limit === undefined ? full : capSegments(full, opts.limit);
    const count = countPoints(segments);

    return { segments, points: count, truncated: count < fullCount };
  }

  async pagePoints(id: string, afterTs: string | undefined, limit: number, signal?: AbortSignal): Promise<TrackPoint[]> {
    const values: unknown[] = [id, limit];
    let cursor = '';

    if (afterTs !== undefined) {
      values.push(afterTs);
      cursor = `AND ts > $${values.length}::timestamptz`;
    }

    const sql = `
      SELECT ts, ST_Y(geog::geometry) AS lat, ST_X(geog::geometry) AS lng, alt, speed, course
      FROM ${this.pointsTable}
      WHERE track_id = $1 ${cursor}
      ORDER BY ts
      LIMIT $2
    `;

    const first = await this.query<PointRow>(sql, values);

    if (first.rows.length > 0 || !signal) {
      return first.rows.map(fromRow);
    }

    // Blocking mode: wait on the shared listener.
    const channel = `${this.pointsTable.toLowerCase()}_channel`;
    await this.ensureListener(channel);

    return await new Promise<TrackPoint[]>((resolve) => {
      const tryRead = async () => {
        try {
          const inner = await this.query<PointRow>(sql, values);

          if (inner.rows.length > 0) {
            cleanup();
            resolve(inner.rows.map(fromRow));
          }
        } catch {
          cleanup();
          resolve([]);
        }
      };

      const onAbort = () => {
        cleanup();
        resolve([]);
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

      // Catch an insert that landed between the first query and the listener.
      tryRead();
    });
  }

  /**
   * Delete a time range. The summary is recomputed rather than adjusted — a
   * deletion can move any of its bounds, and this is rare enough to pay for.
   */
  async deletePoints(id: string, range: TrackRange): Promise<number> {
    const values: unknown[] = [id];
    const where: string[] = [`track_id = $1`];

    if (range.from !== undefined) {
      values.push(range.from);
      where.push(`ts >= $${values.length}::timestamptz`);
    }

    if (range.to !== undefined) {
      values.push(range.to);
      where.push(`ts < $${values.length}::timestamptz`);
    }

    return await this.transaction(async (q) => {
      // Take the track row before touching the points, for two reasons. The
      // recompute below is absolute while `appendPoints` adjusts relatively,
      // so an append committing between this transaction's aggregate and its
      // UPDATE would be overwritten; and both writers taking this lock first
      // is what gives them a consistent lock order, across processes too.
      await q(`SELECT 1 FROM ${this.tracksTable} WHERE id = $1 FOR UPDATE`, [id]);

      const result = await q(`DELETE FROM ${this.pointsTable} WHERE ${where.join(' AND ')}`, values);

      await q(
        `
        UPDATE ${this.tracksTable} t SET
          points = agg.points, first_ts = agg.first_ts, last_ts = agg.last_ts,
          north = agg.north, south = agg.south, east = agg.east, west = agg.west
        FROM (
          SELECT
            COUNT(*) AS points, MIN(ts) AS first_ts, MAX(ts) AS last_ts,
            MAX(ST_Y(geog::geometry)) AS north, MIN(ST_Y(geog::geometry)) AS south,
            MAX(ST_X(geog::geometry)) AS east,  MIN(ST_X(geog::geometry)) AS west
          FROM ${this.pointsTable} WHERE track_id = $1
        ) agg
        WHERE t.id = $1
        `,
        [id],
      );

      return result.rowCount ?? 0;
    });
  }

  async summary(id: string): Promise<TrackSummary> {
    return toSummary(await this.summaryRow(id));
  }

  async summaries(ids: string[]): Promise<Map<string, TrackSummary>> {
    const found = new Map<string, TrackSummary>();
    if (ids.length === 0) return found;

    const result = await this.query<SummaryRow & { id: string }>(
      `SELECT id, points, first_ts, last_ts, north, south, east, west FROM ${this.tracksTable} WHERE id = ANY($1::text[])`,
      [ids],
    );
    for (const row of result.rows) found.set(row.id, toSummary(row));

    return found;
  }

  private async summaryRow(id: string): Promise<SummaryRow & { routing_keys: string[] }> {
    const result = await this.query<SummaryRow & { routing_keys: string[] }>(
      `SELECT points, first_ts, last_ts, north, south, east, west, routing_keys FROM ${this.tracksTable} WHERE id = $1`,
      [id],
    );

    if (result.rows.length === 0) {
      throw new Error(`no track found: ${id}`);
    }

    return result.rows[0];
  }

  private async loadBoundKeys(): Promise<string[]> {
    const result = await this.query<{ routing_key: string }>(
      `SELECT DISTINCT unnest(routing_keys) AS routing_key FROM ${this.tracksTable}`,
    );
    return result.rows.map((row) => row.routing_key);
  }

  private async handleRelayEvent(routingKey: string, payload: unknown): Promise<void> {
    // Answered in memory so an unbound key never costs a pooled connection.
    if (!this.bound.has(routingKey)) {
      return;
    }

    const points = normalizePoints(Array.isArray(payload) ? payload as TrackPoint[] : [payload as TrackPoint]);
    if (points.length === 0) return;

    const res = await this.query<{ id: string }>(
      `
      SELECT id FROM ${this.tracksTable} WHERE routing_keys @> $1
      UNION
      SELECT id FROM ${this.tracksTable}
        WHERE routing_patterns <> '{}' AND $2 ~ ANY(routing_patterns)
      `,
      [[routingKey], routingKey],
    );

    for (const row of res.rows) {
      await this.appendPoints(row.id, points);
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

  /**
   * Run `fn` inside a transaction on a pooled client. `fn` gets its own query
   * function bound to that client, since going through `this.query` would put
   * the statement on a different connection and outside the transaction.
   *
   * Writers are serialized by the track row lock (`FOR UPDATE` in
   * `appendPoints` and `deletePoints`), not by a mutex here: that holds across
   * processes, and reads never wait behind a write.
   */
  private async transaction<T>(fn: (q: QueryFn) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const q: QueryFn = (sql, params) => client.query(sql, params);

    try {
      await q('BEGIN');

      try {
        const result = await fn(q);
        await q('COMMIT');
        return result;
      } catch (error) {
        await q('ROLLBACK');
        throw error;
      }
    } finally {
      client.release();
    }
  }

  private async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]) {
    return await this.pool.query<T>(sql, params);
  }

  private get tracksTable() {
    return this.tablePrefix;
  }

  private get pointsTable() {
    return `${this.tablePrefix}_points`;
  }
}

const fromRow = (row: PointRow): TrackPoint => {
  const point: TrackPoint = { lat: row.lat, lng: row.lng, ts: new Date(row.ts).toISOString() };

  if (row.alt !== null) point.alt = row.alt;
  if (row.speed !== null) point.speed = row.speed;
  if (row.course !== null) point.course = row.course;

  return point;
};

const toSummary = (row: SummaryRow): TrackSummary => {
  const summary: TrackSummary = { points: Number(row.points) };

  if (row.first_ts) summary.firstTs = new Date(row.first_ts).toISOString();
  if (row.last_ts) summary.lastTs = new Date(row.last_ts).toISOString();
  if (row.north !== null && row.south !== null && row.east !== null && row.west !== null) {
    summary.bbox = { north: row.north, south: row.south, east: row.east, west: row.west };
  }

  return summary;
};
