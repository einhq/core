/**
 * PositionRegistry - Manages geographic positions in PostgreSQL with PostGIS
 *
 * Stores point positions with optional radius. Uses GEOGRAPHY type for
 * accurate distance calculations on the Earth's surface.
 */

import type { Pool } from 'pg';
import { ensureResource, ResourceMode } from '../types.ts';
import { assertPolygon, polygonToWkt } from './geo.ts';
import { PositionHandle } from './position-handle.ts';
import { GeoBounds, NearbyMatch, PositionAsyncIO, PositionData, PositionPoint, PositionRegistryIf, PositionResourceOptions, PositionStat, WithinMatch } from './types.ts';

/** What the PostgreSQL-backed registry needs. Here rather than in `types.ts`, which is a contract type file and must not reach `pg`. */
type PositionRegistryConfig = {
  pool: Pool;
  name: string;
};

export class PositionRegistry implements PositionRegistryIf {
  private tableName: string;
  private pool: Pool;
  private initialized = false;

  constructor(private config: PositionRegistryConfig) {
    const name = `${config.name}_positions`;
    if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
      throw new Error(`invalid table name: ${name}`);
    }
    this.tableName = name;
    this.pool = config.pool;
  }

  /** Initialize the registry by enabling PostGIS and creating the positions table. */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const client = await this.pool.connect();
    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS postgis;`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          id            VARCHAR(26) PRIMARY KEY,
          geog          GEOGRAPHY(POINT, 4326),
          radius        DOUBLE PRECISION NOT NULL DEFAULT 0,
          polygon       GEOGRAPHY(POLYGON, 4326),
          size_bytes    INT NOT NULL DEFAULT 0,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.tableName}_geog_idx
        ON ${this.tableName}
        USING GIST (geog)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.tableName}_polygon_idx
        ON ${this.tableName}
        USING GIST (polygon)
      `);

      // Bounding-box queries run in planar lon/lat space (geography envelopes
      // cannot span 180+ degrees of longitude)
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.tableName}_geog_geom_idx
        ON ${this.tableName}
        USING GIST (((geog::geometry)))
      `);
    } finally {
      client.release();
    }

    this.initialized = true;
  }

  /** Release any resources held by the registry. */
  async dispose(): Promise<void> {}

  /** Create a position entry if it does not already exist. Returns true if created. */
  async touch(id: string, _opts: PositionResourceOptions): Promise<boolean> {
    const client = await this.pool.connect();

    try {
      const res = await client.query(
        `
        INSERT INTO ${this.tableName} (id)
        VALUES ($1)
        ON CONFLICT (id) DO NOTHING
        `,
        [id],
      );

      return res.rowCount === 1;
    } finally {
      client.release();
    }
  }

  /** Open a position by id, returning a handle for reading or writing position data. */
  async open(id: string, opts: PositionResourceOptions, mode?: ResourceMode): Promise<PositionHandle> {
    await ensureResource(this, id, opts, mode);

    const io: PositionAsyncIO = {
      get: async () => await this.positionGet(id),
      set: async (data: Uint8Array) => this.positionSet(id, data),
    };

    const rh = new PositionHandle(id, opts, mode || 'r', this, io);
    await rh.init();

    return rh;
  }

  /** Check whether a position with the given id exists. */
  async exists(id: string): Promise<boolean> {
    const client = await this.pool.connect();

    try {
      const result = await client.query<{ exists: boolean }>(
        `
        SELECT EXISTS (
          SELECT 1 FROM ${this.tableName} WHERE id = $1
        ) AS exists
        `,
        [id],
      );

      return result.rows[0]?.exists ?? false;
    } finally {
      client.release();
    }
  }

  /** Return metadata for a position. Throws if not found. */
  async stat(id: string): Promise<PositionStat> {
    const client = await this.pool.connect();

    try {
      const result = await client.query<{ size_bytes: number }>(
        `SELECT size_bytes FROM ${this.tableName} WHERE id = $1`,
        [id],
      );

      if (result.rows.length === 0) {
        throw new Error(`no position found: ${id}`);
      }

      return {
        size: result.rows[0].size_bytes,
      };
    } finally {
      client.release();
    }
  }

  /** Same as stat(). */
  async statX(id: string): Promise<PositionStat> {
    return this.stat(id);
  }

  /** Delete a position by id. Returns true if a row was removed. */
  async delete(id: string): Promise<boolean> {
    const client = await this.pool.connect();

    try {
      const result = await client.query(
        `DELETE FROM ${this.tableName} WHERE id = $1`,
        [id],
      );

      return (result.rowCount ?? 0) > 0;
    } finally {
      client.release();
    }
  }

  /** Return an async iterable of all position ids in the registry. */
  async list(): Promise<AsyncIterable<string>> {
    const client = await this.pool.connect();

    try {
      const result = await client.query<{ id: string }>(
        `SELECT id FROM ${this.tableName}`,
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

  /** Return the total number of positions in the registry. */
  async count(_id?: string): Promise<number> {
    const client = await this.pool.connect();

    try {
      const result = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM ${this.tableName}`,
      );

      return Number(result.rows[0]?.count ?? '0');
    } finally {
      client.release();
    }
  }

  /**
   * Find positions within a given radius of a point.
   * Returns up to `limit` matches ordered by distance.
   */
  async findNearby(lat: number, lng: number, radiusMeters = 10000, limit = 10): Promise<NearbyMatch[]> {
    const client = await this.pool.connect();

    try {
      const result = await client.query<NearbyMatch>(
        `
        SELECT
          id::text,
          ST_Distance(geog, ST_Point($1, $2)::geography) AS distance
        FROM ${this.tableName}
        WHERE geog IS NOT NULL
          AND ST_DWithin(geog, ST_Point($1, $2)::geography, $3)
        ORDER BY distance
        LIMIT $4
        `,
        [lng, lat, radiusMeters, limit],
      );

      return result.rows.map((row) => ({
        id: row.id,
        distance: row.distance,
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Find position points inside a bounding box.
   * Returns up to `limit` matches with their coordinates.
   */
  async findWithin(bounds: GeoBounds, limit = 100): Promise<WithinMatch[]> {
    const client = await this.pool.connect();

    try {
      const result = await client.query<WithinMatch>(
        `
        SELECT
          id::text,
          ST_Y(geog::geometry) AS lat,
          ST_X(geog::geometry) AS lng
        FROM ${this.tableName}
        WHERE geog IS NOT NULL
          AND geog::geometry && ST_MakeEnvelope($1, $2, $3, $4, 4326)
        LIMIT $5
        `,
        [bounds.west, bounds.south, bounds.east, bounds.north, limit],
      );

      return result.rows.map((row) => ({
        id: row.id,
        lat: row.lat,
        lng: row.lng,
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Find positions whose shape contains a point: polygon coverage, or point
   * within radius of the center for polygon-less positions.
   */
  async findContaining(lat: number, lng: number, limit = 10): Promise<NearbyMatch[]> {
    const client = await this.pool.connect();

    try {
      const result = await client.query<NearbyMatch>(
        `
        SELECT
          id::text,
          ST_Distance(geog, ST_Point($1, $2)::geography) AS distance
        FROM ${this.tableName}
        WHERE (polygon IS NOT NULL AND ST_Covers(polygon, ST_Point($1, $2)::geography))
           OR (polygon IS NULL AND geog IS NOT NULL AND radius > 0
               AND ST_DWithin(geog, ST_Point($1, $2)::geography, radius))
        ORDER BY distance
        LIMIT $3
        `,
        [lng, lat, limit],
      );

      return result.rows.map((row) => ({
        id: row.id,
        distance: row.distance,
      }));
    } finally {
      client.release();
    }
  }

  /** The point of each of `ids` that has one, in one query. */
  async getPoints(ids: string[]): Promise<Map<string, PositionPoint>> {
    const points = new Map<string, PositionPoint>();
    if (ids.length === 0) return points;
    const client = await this.pool.connect();

    try {
      const result = await client.query<WithinMatch>(
        `
        SELECT
          id::text,
          ST_Y(geog::geometry) AS lat,
          ST_X(geog::geometry) AS lng
        FROM ${this.tableName}
        WHERE id = ANY($1) AND geog IS NOT NULL
        `,
        [[...new Set(ids)]],
      );

      for (const row of result.rows) points.set(row.id, { lat: row.lat, lng: row.lng });
      return points;
    } finally {
      client.release();
    }
  }

  private async positionSet(id: string, data: Uint8Array): Promise<void> {
    const client = await this.pool.connect();

    try {
      if (data.length === 0) {
        await client.query(
          `UPDATE ${this.tableName} SET geog = NULL, radius = 0, polygon = NULL, size_bytes = 0 WHERE id = $1`,
          [id],
        );
        return;
      }

      const json = new TextDecoder().decode(data);
      const parsed = JSON.parse(json);
      const radius = typeof parsed.radius === 'number' ? parsed.radius : 0;

      if (parsed.polygon !== undefined) {
        // Polygon defines the shape; the center point becomes its centroid
        const wkt = polygonToWkt(assertPolygon(parsed.polygon));

        await client.query(
          `
          UPDATE ${this.tableName}
          SET geog = ST_Centroid(ST_GeomFromText($2, 4326))::geography,
              radius = $3,
              polygon = ST_GeomFromText($2, 4326)::geography,
              size_bytes = $4
          WHERE id = $1
          `,
          [id, wkt, radius, data.length],
        );
        return;
      }

      if (typeof parsed.lat !== 'number' || typeof parsed.lng !== 'number') {
        throw new Error(`invalid position format, must have numeric lat and lng`);
      }

      await client.query(
        `
        UPDATE ${this.tableName}
        SET geog = ST_Point($2, $3)::geography,
            radius = $4,
            polygon = NULL,
            size_bytes = $5
        WHERE id = $1
        `,
        [id, parsed.lng, parsed.lat, radius, data.length],
      );
    } finally {
      client.release();
    }
  }

  private async positionGet(id: string): Promise<Uint8Array> {
    const client = await this.pool.connect();

    try {
      const result = await client.query<{ lat: number; lng: number; radius: number; polygon_geojson: string | null }>(
        `
        SELECT
          ST_Y(geog::geometry) AS lat,
          ST_X(geog::geometry) AS lng,
          radius,
          ST_AsGeoJSON(polygon::geometry) AS polygon_geojson
        FROM ${this.tableName}
        WHERE id = $1 AND geog IS NOT NULL
        `,
        [id],
      );

      if (result.rows.length === 0) {
        return new Uint8Array(0);
      }

      const { lat, lng, radius, polygon_geojson } = result.rows[0];
      const data: PositionData = { lat, lng, radius };

      if (polygon_geojson) {
        const ring = (JSON.parse(polygon_geojson).coordinates?.[0] ?? []) as [number, number][];
        // GeoJSON rings are closed and lng-lat ordered
        data.polygon = ring.slice(0, -1).map(([plng, plat]): PositionPoint => ({ lat: plat, lng: plng }));
      }

      return new TextEncoder().encode(JSON.stringify(data));
    } finally {
      client.release();
    }
  }
}
