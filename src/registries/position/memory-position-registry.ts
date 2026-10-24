/**
 * MemoryPositionRegistry - In-memory geographic positions with haversine
 * proximity search. Mirrors the PostGIS registry semantics: positions are
 * stored as JSON text ({"lat":..,"lng":..,"radius":..,"polygon":..}) encoded
 * as bytes; a polygon defines the shape and recomputes the center point.
 */

import { ensureResource, ResourceMode } from '../types.ts';
import { assertPolygon, boundsContain, haversineMeters, pointInPolygon, polygonCentroid } from './geo.ts';
import { PositionHandle } from './position-handle.ts';
import { GeoBounds, NearbyMatch, PositionAsyncIO, PositionData, PositionPoint, PositionRegistryIf, PositionResourceOptions, PositionStat, WithinMatch } from './types.ts';

type MemoryPositionEntry = {
  lat?: number;
  lng?: number;
  radius?: number;
  polygon?: PositionPoint[];
  size: number;
};

export class MemoryPositionRegistry implements PositionRegistryIf {
  private entries = new Map<string, MemoryPositionEntry>();

  async init(): Promise<void> {}

  async dispose(): Promise<void> {
    this.entries.clear();
  }

  async touch(id: string, _opts: PositionResourceOptions): Promise<boolean> {
    if (this.entries.has(id)) {
      return false;
    }

    this.entries.set(id, { size: 0 });
    return true;
  }

  async open(id: string, opts: PositionResourceOptions, mode?: ResourceMode): Promise<PositionHandle> {
    await ensureResource(this, id, opts, mode);

    const io: PositionAsyncIO = {
      get: async () => {
        const entry = this.entries.get(id);
        if (!entry || entry.lat === undefined || entry.lng === undefined) {
          return new Uint8Array(0);
        }

        const data: PositionData = { lat: entry.lat, lng: entry.lng, radius: entry.radius ?? 0 };
        if (entry.polygon) {
          data.polygon = entry.polygon;
        }

        return new TextEncoder().encode(JSON.stringify(data));
      },
      set: async (data: Uint8Array) => {
        const entry = this.entries.get(id);
        if (!entry) {
          throw new Error(`no position found: ${id}`);
        }

        if (data.length === 0) {
          entry.lat = undefined;
          entry.lng = undefined;
          entry.radius = undefined;
          entry.polygon = undefined;
          entry.size = 0;
          return;
        }

        const parsed = JSON.parse(new TextDecoder().decode(data));
        const radius = typeof parsed.radius === 'number' ? parsed.radius : undefined;

        if (parsed.polygon !== undefined) {
          // Polygon defines the shape; the center point becomes its centroid
          const ring = assertPolygon(parsed.polygon);
          const centroid = polygonCentroid(ring);
          entry.lat = centroid.lat;
          entry.lng = centroid.lng;
          entry.polygon = ring;
        } else {
          if (typeof parsed.lat !== 'number' || typeof parsed.lng !== 'number') {
            throw new Error(`invalid position format, must have numeric lat and lng`);
          }
          entry.lat = parsed.lat;
          entry.lng = parsed.lng;
          entry.polygon = undefined;
        }

        entry.radius = radius;
        entry.size = data.length;
      },
    };

    const rh = new PositionHandle(id, opts, mode || 'r', this, io);
    await rh.init();

    return rh;
  }

  async exists(id: string): Promise<boolean> {
    return this.entries.has(id);
  }

  async stat(id: string): Promise<PositionStat> {
    const entry = this.entries.get(id);

    if (!entry) {
      throw new Error(`no position found: ${id}`);
    }

    return { size: entry.size };
  }

  async statX(id: string): Promise<PositionStat> {
    return this.stat(id);
  }

  async delete(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }

  async list(): Promise<AsyncIterable<string>> {
    const ids = [...this.entries.keys()];

    return (async function* () {
      for (const id of ids) {
        yield id;
      }
    })();
  }

  async count(_id?: string): Promise<number> {
    return this.entries.size;
  }

  /**
   * Find positions within a given radius of a point.
   * Returns up to `limit` matches ordered by distance.
   */
  async findNearby(lat: number, lng: number, radiusMeters = 10000, limit = 10): Promise<NearbyMatch[]> {
    const matches: NearbyMatch[] = [];

    for (const [id, entry] of this.entries) {
      if (entry.lat === undefined || entry.lng === undefined) continue;

      const distance = haversineMeters(lat, lng, entry.lat, entry.lng);
      if (distance <= radiusMeters) {
        matches.push({ id, distance });
      }
    }

    matches.sort((a, b) => a.distance - b.distance);

    return matches.slice(0, limit);
  }

  /**
   * Find position points inside a bounding box.
   * Returns up to `limit` matches with their coordinates.
   */
  async findWithin(bounds: GeoBounds, limit = 100): Promise<WithinMatch[]> {
    const matches: WithinMatch[] = [];

    for (const [id, entry] of this.entries) {
      if (entry.lat === undefined || entry.lng === undefined) continue;

      if (boundsContain(bounds, entry.lat, entry.lng)) {
        matches.push({ id, lat: entry.lat, lng: entry.lng });
        if (matches.length >= limit) break;
      }
    }

    return matches;
  }

  /**
   * Find positions whose shape contains a point: polygon coverage, or point
   * within radius of the center for polygon-less positions.
   */
  async findContaining(lat: number, lng: number, limit = 10): Promise<NearbyMatch[]> {
    const matches: NearbyMatch[] = [];

    for (const [id, entry] of this.entries) {
      if (entry.lat === undefined || entry.lng === undefined) continue;

      const contained = entry.polygon
        ? pointInPolygon(lat, lng, entry.polygon)
        : (entry.radius ?? 0) > 0 && haversineMeters(lat, lng, entry.lat, entry.lng) <= (entry.radius ?? 0);

      if (contained) {
        matches.push({ id, distance: haversineMeters(lat, lng, entry.lat, entry.lng) });
      }
    }

    matches.sort((a, b) => a.distance - b.distance);

    return matches.slice(0, limit);
  }

  /** The point of each of `ids` that has one. */
  async getPoints(ids: string[]): Promise<Map<string, PositionPoint>> {
    const points = new Map<string, PositionPoint>();
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry?.lat !== undefined && entry.lng !== undefined) points.set(id, { lat: entry.lat, lng: entry.lng });
    }
    return points;
  }
}
