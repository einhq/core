/**
 * Geo math shared by the position registry implementations (and consumers):
 * haversine distance, polygon validation/centroid/containment, WKT encoding.
 * Polygons are single rings of {lat,lng} vertices, not closed.
 */

import type { GeoBounds, PositionPoint } from './types.ts';

export { EARTH_RADIUS_M, haversineMeters } from '../../lib/geo/distance.ts';

/** Validate a polygon ring: at least 3 vertices with numeric lat/lng. Returns the ring without a closing vertex. */
export function assertPolygon(polygon: unknown): PositionPoint[] {
  if (!Array.isArray(polygon)) {
    throw new Error('invalid polygon, must be an array of {lat,lng} points');
  }

  const ring = polygon.map((p) => {
    if (typeof p?.lat !== 'number' || typeof p?.lng !== 'number' || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) {
      throw new Error('invalid polygon point, must have numeric lat and lng');
    }
    return { lat: p.lat, lng: p.lng };
  });

  // Drop an explicit closing vertex so the stored ring is open
  if (ring.length > 1 && ring[0].lat === ring[ring.length - 1].lat && ring[0].lng === ring[ring.length - 1].lng) {
    ring.pop();
  }

  if (ring.length < 3) {
    throw new Error('invalid polygon, needs at least 3 distinct points');
  }

  return ring;
}

/** Encode a ring as WKT POLYGON (closing the ring, lng-lat axis order). */
export function polygonToWkt(ring: PositionPoint[]): string {
  const closed = [...ring, ring[0]];
  return `POLYGON((${closed.map((p) => `${p.lng} ${p.lat}`).join(', ')}))`;
}

/** Planar (shoelace) centroid of a ring; falls back to the vertex average for degenerate areas. */
export function polygonCentroid(ring: PositionPoint[]): PositionPoint {
  let area = 0;
  let lat = 0;
  let lng = 0;

  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const cross = a.lng * b.lat - b.lng * a.lat;
    area += cross;
    lng += (a.lng + b.lng) * cross;
    lat += (a.lat + b.lat) * cross;
  }

  if (Math.abs(area) < 1e-12) {
    const n = ring.length;
    return {
      lat: ring.reduce((s, p) => s + p.lat, 0) / n,
      lng: ring.reduce((s, p) => s + p.lng, 0) / n,
    };
  }

  return { lat: lat / (3 * area), lng: lng / (3 * area) };
}

/** Planar ray-casting point-in-polygon test (boundary counts as inside loosely). */
export function pointInPolygon(lat: number, lng: number, ring: PositionPoint[]): boolean {
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    const intersects = (a.lat > lat) !== (b.lat > lat) &&
      lng < ((b.lng - a.lng) * (lat - a.lat)) / (b.lat - a.lat) + a.lng;
    if (intersects) inside = !inside;
  }

  return inside;
}

/** Whether a point lies inside a bounding box. */
export function boundsContain(bounds: GeoBounds, lat: number, lng: number): boolean {
  return lat <= bounds.north && lat >= bounds.south && lng <= bounds.east && lng >= bounds.west;
}
