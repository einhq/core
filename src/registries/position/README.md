# Position Registry

Geographic positions backed by PostgreSQL with PostGIS. Each position is a point with an optional shape: a radius (circle) or a polygon ring. Supports proximity, bounding-box and containment queries.

## Backend

PostgreSQL + PostGIS (`GEOGRAPHY(POINT)` + `GEOGRAPHY(POLYGON)`), or in-memory with haversine / ray-casting math for the fast test tier.

## Core Concepts

- **Data format**: handles read/write JSON text — `{"lat":..,"lng":..,"radius":..,"polygon":[{"lat":..,"lng":..},..]}`.
- **Shapes**: default is point + radius. A `polygon` (single open ring, ≥3 vertices) overrides the radius as the position's shape and recenters `lat`/`lng` on the polygon centroid.
- **Owners**: the types of the nodes a position is a child of (`location`, `file`), recorded by the VFS with `setOwners` whenever a position's parents change. `unowned(limit)` lists the positions never given any, which the VFS records at `initialize`. A position with no parent has an empty list.
- **Queries**, each with an optional `filter` last — `{ ownerTypes: ['location'] }` keeps the positions with an owner of one of those types, before `limit` is applied:
  - `findNearby(lat, lng, radiusMeters?, limit?, filter?)` — points within a distance, ordered by distance.
  - `findWithin(bounds, limit?, filter?)` — points inside a `{north,south,east,west}` bounding box (planar lon/lat, for map viewports).
  - `findContaining(lat, lng, limit?, filter?)` — positions whose shape covers the point: polygon coverage, or point within `radius` for polygon-less positions.
  - `getPoints(ids)` — the point of each id, in one lookup (a polygon's centroid); ids with no stored point are absent. For a caller that already holds the position ids — a batch of files' `position` children — and needs their coordinates without a search.

## SQL Schema

```sql
CREATE TABLE {prefix}_positions (
  id            VARCHAR(26) PRIMARY KEY,
  geog          GEOGRAPHY(POINT, 4326),
  radius        DOUBLE PRECISION NOT NULL DEFAULT 0,
  polygon       GEOGRAPHY(POLYGON, 4326),
  owner_types   TEXT[],                -- NULL until recorded
  size_bytes    INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- GIST indexes on geog, polygon and (geog::geometry) (bbox queries run in
-- planar space; geography envelopes cannot span 180+ degrees of longitude),
-- a GIN index on owner_types, and a partial index on the unowned ids
```

## Usage

```typescript
const registry = new PositionRegistry({ pool: pgPool, name: 'app' });
await registry.init();

// Store a circle
const w = await registry.open('home', {}, 'w');
await w.write(new TextEncoder().encode(JSON.stringify({ lat: 57.7, lng: 11.97, radius: 500 })));
await w.close();

// Store a polygon (lat/lng recomputed as its centroid)
const p = await registry.open('park', {}, 'w');
await p.write(new TextEncoder().encode(JSON.stringify({
  polygon: [{ lat: 57.684, lng: 11.942 }, { lat: 57.684, lng: 11.946 }, { lat: 57.686, lng: 11.946 }],
})));
await p.close();

await registry.findNearby(57.7, 11.97, 10000, 10); // [{id, distance}]
await registry.findWithin({ north: 57.7, south: 57.6, east: 12.0, west: 11.9 }); // [{id, lat, lng}]
await registry.findContaining(57.685, 11.944); // [{id, distance}] — shapes covering the point
await registry.getPoints(['home', 'park']); // Map id → {lat, lng}

await registry.setOwners(new Map([['park', ['location']]]));
await registry.findNearby(57.7, 11.97, 10000, 10, { ownerTypes: ['location'] }); // only 'park'
```

## Configuration

| Option | Type    | Description                |
| ------ | ------- | -------------------------- |
| `pool` | pg.Pool | PostgreSQL connection pool |
| `name` | string  | Prefix for table names     |

Geo math helpers (haversine, polygon validation/centroid/point-in-polygon, WKT encoding) live in `geo.ts` and are shared by both implementations and the position shell commands.
