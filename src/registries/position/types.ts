import { RegistryIf, ResourceOptions } from '../types.ts';

export type PositionResourceOptions = ResourceOptions;

export type PositionStat = {
  size: number;
};

/** Async get/set IO pair used by handles backed by external storage. */
export interface PositionAsyncIO {
  get: () => Promise<Uint8Array>;
  set: (data: Uint8Array) => Promise<void>;
}

/** A single geographic coordinate. */
export type PositionPoint = {
  lat: number;
  lng: number;
};

/**
 * JSON document stored through a position handle. A position is a point with
 * an optional radius (circle) or an optional polygon ring. When a polygon is
 * set the registry recomputes lat/lng as the polygon centroid and the polygon
 * defines the shape; radius is only meaningful without a polygon.
 */
export type PositionData = PositionPoint & {
  radius?: number;
  /** Single polygon ring (at least 3 vertices, not closed). */
  polygon?: PositionPoint[];
};

/** Geographic bounding box (viewport). */
export type GeoBounds = {
  north: number;
  south: number;
  east: number;
  west: number;
};

/** Result of a proximity search, pairing a position id with its distance in meters. */
export type NearbyMatch = {
  /** The id of the matched position. */
  id: string;
  /** Distance in meters from the query point. */
  distance: number;
};

/** Result of a bounding-box search: a position id with its point coordinate. */
export type WithinMatch = PositionPoint & {
  /** The id of the matched position. */
  id: string;
};

/** Registry interface for storing and querying geographic positions. */
export interface PositionRegistryIf extends RegistryIf<PositionResourceOptions, PositionStat> {
  /**
   * Find positions within a given radius of a point.
   * Returns up to `limit` matches ordered by distance.
   */
  findNearby(lat: number, lng: number, radiusMeters?: number, limit?: number): Promise<NearbyMatch[]>;

  /**
   * Find position points inside a bounding box.
   * Returns up to `limit` matches with their coordinates.
   */
  findWithin(bounds: GeoBounds, limit?: number): Promise<WithinMatch[]>;

  /**
   * Find positions whose shape contains a point: the polygon covers it, or —
   * for polygon-less positions — the point is within radius of the center.
   * Returns up to `limit` matches ordered by distance to the center.
   */
  findContaining(lat: number, lng: number, limit?: number): Promise<NearbyMatch[]>;

  /**
   * The point of each of `ids`, in one lookup: a polygon's is its centroid. Ids with no stored
   * point (unknown, or cleared) are absent from the map.
   */
  getPoints(ids: string[]): Promise<Map<string, PositionPoint>>;
}
