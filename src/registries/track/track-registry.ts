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
 *
 * Every write is judged by the rules (`rules.ts`) in its own transaction: a
 * fix's `rule` says whether it was rejected or the line is cut before it, its
 * `manual` what a person said of it, which overrules the rule, and a read
 * leaves out what was rejected.
 */
import type { Pool, PoolClient } from 'pg';
import type { RelayEventUnsubscriber, RouterManagerIf } from '../../managers/router/mod.ts';
import { createExtension } from '../../lib/pg/mod.ts';
import { BoundRoutingKeys } from '../bound-routing-keys.ts';
import { routingPatternSources } from '../routing-key-match.ts';
import { ensureResource, ResourceMode } from '../types.ts';
import { countPoints, DEFAULT_MARGIN, normalizePoints, stripSegments, summarize } from './lib.ts';
import { judgeFixes, JUMP_MAX_GAP_MS, JUMP_MIN_M, RULES_REACH_MS, RULES_VERSION } from './rules.ts';
import { capSegments, dropLoneSpikes, expandBounds, splitRuns, STILL_MAX_SPEED, toSegments } from './segment.ts';
import { TrackHandle } from './track-handle.ts';
import {
  TrackIO,
  TrackPoint,
  TrackPointInput,
  TrackRange,
  TrackReadOptions,
  TrackReadResult,
  TrackRegistryIf,
  TrackResourceOptions,
  TrackSelection,
  TrackStat,
  TrackSummary,
  TrackVerdict,
} from './types.ts';

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
type QueryFn = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rowCount: number | null; rows: T[] }>;

/** How many fixes a track judged from scratch is judged in at a time. */
const JUDGE_CHUNK = 50_000;

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
  rule: string | null;
  manual: string | null;
};

/**
 * The fixes a read keeps unless it asks for the rejected ones: those a person accepted, and
 * those no rule rejected that a person did not reject.
 */
const ACCEPTED = `(CASE manual WHEN 'accept' THEN true WHEN 'reject' THEN false ELSE rule IS DISTINCT FROM 'excursion' END)`;

/** The fixes the rules judge: all but those a person rejected, so the track is judged without them. */
const JUDGED = `manual IS DISTINCT FROM 'reject'`;

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

  // Each track judged by the current rules since this registry started, or being judged
  private judged = new Map<string, Promise<void>>();

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

    await createExtension(this.pool, 'postgis');

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

    // The version of the rules the track's fixes were last judged by; 0 for never.
    await this.query(`ALTER TABLE ${this.tracksTable} ADD COLUMN IF NOT EXISTS rules INTEGER NOT NULL DEFAULT 0`);

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

    // What the rules made of the fix: NULL for accepted, `excursion` for rejected, `jump` for a fix
    // the line is cut before.
    await this.query(`ALTER TABLE ${this.pointsTable} ADD COLUMN IF NOT EXISTS rule TEXT`);

    // What a person said of the fix, which judging never touches: NULL for nothing, `reject` or
    // `accept`. A fix a person rejected is not judged, and has no rule.
    await this.query(`ALTER TABLE ${this.pointsTable} ADD COLUMN IF NOT EXISTS manual TEXT`);

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
      INSERT INTO ${this.tracksTable} (id, routing_keys, routing_patterns, rules)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (id) DO UPDATE SET
        routing_keys = EXCLUDED.routing_keys,
        routing_patterns = EXCLUDED.routing_patterns
      WHERE ${this.tracksTable}.routing_keys IS DISTINCT FROM EXCLUDED.routing_keys
        OR ${this.tracksTable}.routing_patterns IS DISTINCT FROM EXCLUDED.routing_patterns
      `,
      [id, routingKeys, routingPatternSources(routingKeys), RULES_VERSION],
    );

    return result.rowCount === 1;
  }

  async open(id: string, opts: TrackResourceOptions, mode?: ResourceMode): Promise<TrackHandle> {
    const { truncate } = await ensureResource(this, id, opts, mode);

    if (truncate) {
      await this.deletePoints(id, {});
    }

    const io: TrackIO = {
      append: (points: TrackPointInput[]) => this.appendPoints(id, points),
      page: (afterTs, limit, signal) => this.pagePoints(id, afterTs, limit, signal),
      read: (readOpts) => this.readPoints(id, readOpts),
      remove: (range) => this.deletePoints(id, range),
      mark: (selection, verdict) => this.markPoints(id, selection, verdict),
      move: (range, to) => this.movePoints(id, to, range),
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
    this.judged.delete(id);

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
   * Insert points, ignoring timestamps already present, judge the fixes within
   * reach of them, and fold them into the summary in the same transaction so
   * the two cannot drift. When the judging changed a verdict the summary is
   * counted again instead, since a rejected fix is no part of it.
   *
   * A whole GPX file arrives in one call, so the points travel as six parallel
   * arrays and are unnested into rows in postgres. A tuple list does not survive
   * the size: a bind message counts its parameters in 16 bits, so past ~10 900
   * fixes the count wraps and postgres reports a mismatch against a number
   * nobody asked for. This way the statement takes seven parameters whatever
   * the file weighs.
   */
  async appendPoints(id: string, points: TrackPointInput[]): Promise<number> {
    const incoming = normalizePoints(points);

    if (incoming.length === 0) return 0;

    await this.ensureJudged(id);
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

      if (written > 0 && await this.judgeAround(q, id, Date.parse(summary.firstTs!), Date.parse(summary.lastTs!)) > 0) {
        await this.recount(q, id);
      } else if (written > 0) {
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
   *
   * A `still` read drops lone spikes first, in SQL on the simplified path, and
   * collapses still periods on what comes back (`toSegments`). A fix a person
   * accepted is no spike to either, so a simplified vertex carries its `manual`
   * verdict until then.
   *
   * Rejected fixes are left out unless asked for. The fix a jump lands on starts
   * a new run, numbered in SQL, and nothing joins two runs: each is despiked,
   * simplified and cut on its own. Read alone, the rejected fixes start a run
   * after each accepted fix instead.
   */
  async readPoints(id: string, opts: TrackReadOptions = {}): Promise<TrackReadResult> {
    await this.ensureJudged(id);

    const values: unknown[] = [id];
    const where: string[] = [`track_id = $1`];

    if (!opts.rejected) where.push(ACCEPTED);

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

    const columns = `ts, geog, alt, speed, course, rule, manual`;
    const numbered = opts.rejected === 'only'
      ? `
        SELECT * FROM (
          SELECT ${columns}, COUNT(*) FILTER (WHERE ${ACCEPTED}) OVER (ORDER BY ts)::int AS run, ${ACCEPTED} AS accepted
          FROM ${this.pointsTable}
          WHERE ${where.join(' AND ')}
        ) marked
        WHERE NOT accepted
      `
      : `
        SELECT ${columns}, COUNT(*) FILTER (WHERE rule = 'jump') OVER (ORDER BY ts)::int AS run
        FROM ${this.pointsTable}
        WHERE ${where.join(' AND ')}
      `;

    const tolerance = opts.tolerance ?? 0;
    let runs: TrackPoint[][];

    if (tolerance > 0) {
      // A still read drops lone spikes before simplifying, as `dropLoneSpikes` does: a fix reached
      // and left faster than the maximum speed, within its run, unless a person accepted it.
      let source = numbered;

      if (opts.still) {
        values.push(opts.still.maxSpeed ?? STILL_MAX_SPEED);
        const max = `$${values.length}::double precision`;
        source = `
          SELECT ts, geog, run, manual FROM (
            SELECT ts, geog, run, manual,
              ST_Distance(LAG(geog) OVER w, geog, false) / EXTRACT(EPOCH FROM ts - LAG(ts) OVER w) AS speed_in,
              ST_Distance(geog, LEAD(geog) OVER w, false) / EXTRACT(EPOCH FROM LEAD(ts) OVER w - ts) AS speed_out
            FROM (${numbered}) numbered
            WINDOW w AS (PARTITION BY run ORDER BY ts)
          ) neighbours
          WHERE manual = 'accept' OR NOT (speed_in > ${max} AND speed_out > ${max})
        `;
      }

      values.push(tolerance);

      // A vertex keeps its fix's M, so the accepted fixes' Ms say which vertices a person accepted.
      const result = await this.query<{ lat: number; lng: number; m: number; run: number; accepted: boolean }>(
        `
        WITH lines AS (
          SELECT
            (ts AT TIME ZONE 'UTC')::date AS day,
            run,
            ST_MakeLine(
              ST_MakePointM(ST_X(geog::geometry), ST_Y(geog::geometry), EXTRACT(EPOCH FROM ts)::double precision) ORDER BY ts
            ) AS line,
            array_agg(EXTRACT(EPOCH FROM ts)::double precision) FILTER (WHERE manual = 'accept') AS accepted
          FROM (${source}) filtered
          GROUP BY 1, 2
        )
        SELECT ST_Y(dp.geom) AS lat, ST_X(dp.geom) AS lng, ST_M(dp.geom) AS m, l.run,
          COALESCE(ST_M(dp.geom) = ANY(l.accepted), false) AS accepted
        FROM lines l
        CROSS JOIN LATERAL ST_DumpPoints(ST_Simplify(l.line, $${values.length}::double precision, true)) dp
        ORDER BY l.day, l.run, dp.path[1]
        `,
        values,
      );

      runs = splitRuns(result.rows, (row, previous) => row.run !== previous.run).map((run) =>
        run.map((row): TrackPoint => ({ lat: row.lat, lng: row.lng, ts: new Date(row.m * 1000).toISOString(), ...(row.accepted && { manual: 'accept' }) }))
      );
    } else {
      const result = await this.query<PointRow & { run: number }>(
        `
        SELECT ts, ST_Y(geog::geometry) AS lat, ST_X(geog::geometry) AS lng, alt, speed, course, rule, manual, run
        FROM (${numbered}) numbered
        ORDER BY ts
        `,
        values,
      );

      runs = splitRuns(result.rows, (row, previous) => row.run !== previous.run).map((run) => {
        const points = run.map(fromRow);
        return opts.still ? dropLoneSpikes(points, opts.still.maxSpeed) : points;
      });
    }

    // Simplification already happened in SQL; what is left is collapsing still periods and the day/pause cut.
    const cut = runs.flatMap((run) => toSegments(run, 0, opts.still));
    const full = tolerance > 0 ? stripSegments(cut) : cut;
    const fullCount = countPoints(full);

    const segments = opts.limit === undefined ? full : capSegments(full, opts.limit);
    const count = countPoints(segments);

    return { segments, points: count, truncated: count < fullCount };
  }

  async pagePoints(id: string, afterTs: string | undefined, limit: number, signal?: AbortSignal): Promise<TrackPoint[]> {
    await this.ensureJudged(id);

    const values: unknown[] = [id, limit];
    let cursor = '';

    if (afterTs !== undefined) {
      values.push(afterTs);
      cursor = `AND ts > $${values.length}::timestamptz`;
    }

    const sql = `
      SELECT ts, ST_Y(geog::geometry) AS lat, ST_X(geog::geometry) AS lng, alt, speed, course, rule, manual
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
   * Delete a time range, and judge again the fixes within reach of its ends.
   * The summary is recomputed rather than adjusted — a deletion can move any
   * of its bounds, and this is rare enough to pay for.
   */
  async deletePoints(id: string, range: TrackRange): Promise<number> {
    await this.ensureJudged(id);

    const values: unknown[] = [id];
    const where = [`track_id = $1`, ...selectionWhere(values, range)];

    return await this.transaction(async (q) => {
      // Take the track row before touching the points, for two reasons. The
      // recompute below is absolute while `appendPoints` adjusts relatively,
      // so an append committing between this transaction's aggregate and its
      // UPDATE would be overwritten; and both writers taking this lock first
      // is what gives them a consistent lock order, across processes too.
      await q(`SELECT 1 FROM ${this.tracksTable} WHERE id = $1 FOR UPDATE`, [id]);

      const result = await q(`DELETE FROM ${this.pointsTable} WHERE ${where.join(' AND ')}`, values);

      if ((result.rowCount ?? 0) > 0) {
        for (const end of [range.from, range.to]) {
          if (end !== undefined) await this.judgeAround(q, id, Date.parse(end), Date.parse(end));
        }
      }

      await this.recount(q, id);

      return result.rowCount ?? 0;
    });
  }

  /**
   * Set a person's verdict on a selection, or clear it, judge again what that
   * changes, and count the summary again. A fix a person rejects loses its rule,
   * since the rules judge the track without it.
   */
  async markPoints(id: string, selection: TrackSelection, verdict: TrackVerdict | null): Promise<number> {
    await this.ensureJudged(id);

    const values: unknown[] = [id, verdict];
    const where = [`track_id = $1`, `manual IS DISTINCT FROM $2::text`, ...selectionWhere(values, selection)];

    return await this.transaction(async (q) => {
      // Locked first, as the other writers lock it.
      const track = await q(`SELECT 1 FROM ${this.tracksTable} WHERE id = $1 FOR UPDATE`, [id]);
      if ((track.rowCount ?? 0) === 0) throw new Error(`no track found: ${id}`);

      // The span whose judging changes: the fixes a person rejects now or rejected before.
      const result = await q<{ changed: string; first: Date | null; last: Date | null }>(
        `
        WITH target AS (
          SELECT ts, manual FROM ${this.pointsTable} WHERE ${where.join(' AND ')}
        ), marked AS (
          UPDATE ${this.pointsTable} p SET
            manual = $2::text,
            rule = CASE WHEN $2::text = 'reject' THEN NULL ELSE p.rule END
          FROM target
          WHERE p.track_id = $1 AND p.ts = target.ts
        )
        SELECT
          COUNT(*) AS changed,
          MIN(ts) FILTER (WHERE manual = 'reject' OR $2::text = 'reject') AS first,
          MAX(ts) FILTER (WHERE manual = 'reject' OR $2::text = 'reject') AS last
        FROM target
        `,
        values,
      );

      const { changed, first, last } = result.rows[0];
      if (first && last) {
        await this.judgeChunks(q, id, new Date(first).getTime() - RULES_REACH_MS, new Date(last).getTime() + RULES_REACH_MS);
      }
      if (Number(changed) > 0) await this.recount(q, id);

      return Number(changed);
    });
  }

  /**
   * Move a time range to another track in one statement, the rows leaving one track and landing
   * on the other with what a person said of them; then judge again what is within reach of the
   * range's ends on `from` and of the fixes that landed on `to`, and count both summaries again.
   */
  async movePoints(from: string, to: string, range: TrackRange): Promise<number> {
    if (from === to) throw new Error(`cannot move fixes from a track to itself: ${from}`);
    await Promise.all([this.ensureJudged(from), this.ensureJudged(to)]);

    const values: unknown[] = [from, to];
    const where = [`track_id = $1`, ...selectionWhere(values, range)];

    return await this.transaction(async (q) => {
      // Both rows locked before any point, as the other writers lock theirs, and in id order, so
      // two moves between the same tracks queue rather than deadlock.
      const locked = await q<{ id: string }>(`SELECT id FROM ${this.tracksTable} WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`, [[from, to]]);
      const missing = [from, to].find((id) => !locked.rows.some((row) => row.id === id));
      if (missing) throw new Error(`no track found: ${missing}`);

      const result = await q<{ moved: string; first: Date | null; last: Date | null }>(
        `
        WITH gone AS (
          DELETE FROM ${this.pointsTable} WHERE ${where.join(' AND ')}
          RETURNING ts, geog, alt, speed, course, manual
        ), landed AS (
          INSERT INTO ${this.pointsTable} (track_id, ts, geog, alt, speed, course, manual)
          SELECT $2, ts, geog, alt, speed, course, manual FROM gone
          ON CONFLICT (track_id, ts) DO NOTHING
        )
        SELECT COUNT(*) AS moved, MIN(ts) AS first, MAX(ts) AS last FROM gone
        `,
        values,
      );

      const { moved, first, last } = result.rows[0];
      if (Number(moved) === 0) return 0;

      for (const end of [range.from, range.to]) {
        if (end !== undefined) await this.judgeAround(q, from, Date.parse(end), Date.parse(end));
      }
      await this.judgeChunks(q, to, new Date(first!).getTime() - RULES_REACH_MS, new Date(last!).getTime() + RULES_REACH_MS);

      await this.recount(q, from);
      await this.recount(q, to);

      return Number(moved);
    });
  }

  async summary(id: string): Promise<TrackSummary> {
    await this.ensureJudged(id);
    return toSummary(await this.summaryRow(id));
  }

  /** Count the summary again from the track's accepted fixes. */
  private async recount(q: QueryFn, id: string): Promise<void> {
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
        FROM ${this.pointsTable} WHERE track_id = $1 AND ${ACCEPTED}
      ) agg
      WHERE t.id = $1
      `,
      [id],
    );
  }

  /**
   * Judge again what a change between `from` and `to` (epoch ms) can have
   * changed the verdict of: the fixes within `RULES_REACH_MS` of it. Every rule
   * needs a leap, so a window holding none, and no fix a rule marked, is left
   * as it is without reading it. Returns how many verdicts changed.
   */
  private async judgeAround(q: QueryFn, id: string, from: number, to: number): Promise<number> {
    const low = from - RULES_REACH_MS;
    const high = to + RULES_REACH_MS;
    const check = await q<{ found: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1 FROM (
          SELECT rule,
            EXTRACT(EPOCH FROM ts - LAG(ts) OVER w) * 1000 AS gap,
            ST_Distance(LAG(geog) OVER w, geog, false) AS distance
          FROM ${this.pointsTable}
          WHERE track_id = $1 AND ts >= $2 AND ts <= $3 AND ${JUDGED}
          WINDOW w AS (ORDER BY ts)
        ) steps
        WHERE rule IS NOT NULL OR (gap <= $4 AND distance > $5)
      ) AS found
      `,
      // A spheroid is not a sphere: a little short of the rules' distance, so no leap is missed.
      [id, new Date(low), new Date(high), JUMP_MAX_GAP_MS, JUMP_MIN_M * 0.99],
    );

    return check.rows[0]?.found ? await this.judgeWindow(q, id, low, high) : 0;
  }

  /**
   * Judge the fixes between `from` and `to` (epoch ms, inclusive), reading
   * `RULES_REACH_MS` more on each side for what they are judged against, and
   * write the verdicts that changed. Returns how many did. A fix a person
   * rejected is neither judged nor judged against.
   */
  private async judgeWindow(q: QueryFn, id: string, from: number, to: number): Promise<number> {
    const result = await q<{ ts: Date; lat: number; lng: number; rule: string | null }>(
      `
      SELECT ts, ST_Y(geog::geometry) AS lat, ST_X(geog::geometry) AS lng, rule
      FROM ${this.pointsTable}
      WHERE track_id = $1 AND ts >= $2 AND ts <= $3 AND ${JUDGED}
      ORDER BY ts
      `,
      [id, new Date(from - RULES_REACH_MS), new Date(to + RULES_REACH_MS)],
    );

    const fixes = result.rows.map((row) => ({ ms: new Date(row.ts).getTime(), lat: row.lat, lng: row.lng }));
    const verdicts = judgeFixes(fixes);
    const ts: Date[] = [];
    const rules: (string | null)[] = [];

    fixes.forEach((fix, i) => {
      if (fix.ms < from || fix.ms > to || (verdicts[i] ?? null) === result.rows[i].rule) return;
      ts.push(new Date(fix.ms));
      rules.push(verdicts[i]);
    });

    if (ts.length > 0) {
      await q(
        `
        UPDATE ${this.pointsTable} p SET rule = verdict.rule
        FROM unnest($2::timestamptz[], $3::text[]) AS verdict(ts, rule)
        WHERE p.track_id = $1 AND p.ts = verdict.ts
        `,
        [id, ts, rules],
      );
    }

    return ts.length;
  }

  /**
   * Judge a track by the current rules once, if it was last judged by older
   * ones: every fix, `JUDGE_CHUNK` at a time, then the summary again. Later
   * calls share the first.
   */
  private ensureJudged(id: string): Promise<void> {
    let pending = this.judged.get(id);

    if (!pending) {
      pending = this.judgeTrack(id).catch((error) => {
        this.judged.delete(id);
        throw error;
      });
      this.judged.set(id, pending);
    }

    return pending;
  }

  private async judgeTrack(id: string): Promise<void> {
    const version = await this.query<{ rules: number }>(`SELECT rules FROM ${this.tracksTable} WHERE id = $1`, [id]);
    if ((version.rows[0]?.rules ?? RULES_VERSION) >= RULES_VERSION) return;

    await this.transaction(async (q) => {
      // Locked first, as the other writers lock it.
      await q(`SELECT 1 FROM ${this.tracksTable} WHERE id = $1 FOR UPDATE`, [id]);

      const span = (await q<{ first: Date | null; last: Date | null }>(
        `SELECT MIN(ts) AS first, MAX(ts) AS last FROM ${this.pointsTable} WHERE track_id = $1`,
        [id],
      )).rows[0];
      if (span?.first && span.last) await this.judgeChunks(q, id, new Date(span.first).getTime(), new Date(span.last).getTime());

      await this.recount(q, id);
      await q(`UPDATE ${this.tracksTable} SET rules = $2 WHERE id = $1`, [id, RULES_VERSION]);
    });
  }

  /** Judge the fixes between `from` and `to` (epoch ms, inclusive), `JUDGE_CHUNK` at a time. */
  private async judgeChunks(q: QueryFn, id: string, from: number, to: number): Promise<void> {
    let start: number | undefined = from;

    while (start !== undefined) {
      // The first fix of the next chunk, if there is one before `to`.
      const next: Date | undefined = (await q<{ ts: Date }>(
        `SELECT ts FROM ${this.pointsTable} WHERE track_id = $1 AND ts >= $2 AND ts <= $3 ORDER BY ts OFFSET $4 LIMIT 1`,
        [id, new Date(start), new Date(to), JUDGE_CHUNK],
      )).rows[0]?.ts;
      const end: number | undefined = next ? new Date(next).getTime() : undefined;

      await this.judgeWindow(q, id, start, end !== undefined ? end - 1 : to);
      start = end;
    }
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

/** Metres in a degree of latitude, a little short, so a box widened by it holds the whole circle. */
const METRES_PER_DEGREE = 111_000;

/**
 * The conditions that keep the fixes of a selection, its parameters pushed onto `values`. A `near`
 * is tested on the sphere, after a box around it that the spatial index answers.
 */
const selectionWhere = (values: unknown[], selection: TrackSelection): string[] => {
  const where: string[] = [];
  const param = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };

  if (selection.from !== undefined) where.push(`ts >= ${param(selection.from)}::timestamptz`);
  if (selection.to !== undefined) where.push(`ts < ${param(selection.to)}::timestamptz`);
  if (selection.marked !== undefined) where.push(`manual = ${param(selection.marked)}::text`);

  if (selection.near) {
    const { lat, lng, radius } = selection.near;
    const dLat = radius / METRES_PER_DEGREE;
    const dLng = dLat / Math.max(Math.cos(lat * Math.PI / 180), 0.01);
    where.push(
      `geog::geometry && ST_MakeEnvelope(${param(lng - dLng)}::double precision, ${param(lat - dLat)}::double precision, ` +
        `${param(lng + dLng)}::double precision, ${param(lat + dLat)}::double precision, 4326)`,
    );
    where.push(
      `ST_DWithin(geog, ST_SetSRID(ST_MakePoint(${param(lng)}::double precision, ${param(lat)}::double precision), 4326)::geography, ` +
        `${param(radius)}::double precision, false)`,
    );
  }

  return where;
};

const fromRow = (row: PointRow): TrackPoint => {
  const point: TrackPoint = { lat: row.lat, lng: row.lng, ts: new Date(row.ts).toISOString() };

  if (row.alt !== null) point.alt = row.alt;
  if (row.speed !== null) point.speed = row.speed;
  if (row.course !== null) point.course = row.course;
  if (row.manual === 'reject') point.rejected = 'manual';
  else if (row.manual === null && row.rule === 'excursion') point.rejected = row.rule;
  if (row.manual === 'reject' || row.manual === 'accept') point.manual = row.manual;

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
