/**
 * Region filtering for `search`.
 *
 * A region is always resolved as: bounding box → `vfs.findWithin` → exact JS
 * refinement. The bbox is what the position registry can serve; the refinement
 * is what makes a circle actually round and a polygon actually that polygon.
 * This needs no new registry primitive and works against MemoryPositionRegistry
 * in the fast tier.
 */

import type { GeoBounds, PositionPoint } from '../../registries/position/types.ts';
import { boundsContain, pointInPolygon } from '../../registries/position/geo.ts';
import { haversineMeters } from '../geo/distance.ts';

export type Region =
  | { shape: 'bbox'; bounds: GeoBounds }
  | { shape: 'circle'; lat: number; lng: number; radius: number; bounds: GeoBounds }
  | { shape: 'polygon'; ring: PositionPoint[]; bounds: GeoBounds };

const METERS_PER_DEG_LAT = 111320;

const circleBounds = (lat: number, lng: number, radius: number): GeoBounds => {
  // Guard the cos() near the poles so the box never collapses or flips sign.
  const lngMeters = Math.max(METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180), 1);
  return {
    north: lat + radius / METERS_PER_DEG_LAT,
    south: lat - radius / METERS_PER_DEG_LAT,
    east: lng + radius / lngMeters,
    west: lng - radius / lngMeters,
  };
};

const ringBounds = (ring: PositionPoint[]): GeoBounds => ({
  north: Math.max(...ring.map((p) => p.lat)),
  south: Math.min(...ring.map((p) => p.lat)),
  east: Math.max(...ring.map((p) => p.lng)),
  west: Math.min(...ring.map((p) => p.lng)),
});

const numbers = (input: string, count: number): number[] | undefined => {
  const parts = input.split(',').map((p) => Number(p.trim()));
  if (parts.length !== count || parts.some((n) => !Number.isFinite(n))) return undefined;
  return parts;
};

/** `--bbox north,south,east,west` */
export const parseBbox = (input: string): Region | undefined => {
  const parsed = numbers(input, 4);
  if (!parsed) return undefined;
  const [north, south, east, west] = parsed;
  if (north < south) return undefined;
  return { shape: 'bbox', bounds: { north, south, east, west } };
};

/** `--circle lat,lng,radiusMeters` */
export const parseCircle = (input: string): Region | undefined => {
  const parsed = numbers(input, 3);
  if (!parsed) return undefined;
  const [lat, lng, radius] = parsed;
  if (radius <= 0) return undefined;
  return { shape: 'circle', lat, lng, radius, bounds: circleBounds(lat, lng, radius) };
};

/** `--polygon "lat,lng;lat,lng;lat,lng"` — at least 3 vertices, not closed. */
export const parsePolygon = (input: string): Region | undefined => {
  const ring: PositionPoint[] = [];
  for (const vertex of input.split(';')) {
    if (!vertex.trim()) continue;
    const parsed = numbers(vertex, 2);
    if (!parsed) return undefined;
    ring.push({ lat: parsed[0], lng: parsed[1] });
  }
  if (ring.length < 3) return undefined;
  return { shape: 'polygon', ring, bounds: ringBounds(ring) };
};

/** Exact containment test, run over the bbox candidates the registry returned. */
export const regionContains = (region: Region, lat: number, lng: number): boolean => {
  switch (region.shape) {
    case 'bbox':
      return boundsContain(region.bounds, lat, lng);
    case 'circle':
      return haversineMeters(region.lat, region.lng, lat, lng) <= region.radius;
    case 'polygon':
      return pointInPolygon(lat, lng, region.ring);
  }
};
