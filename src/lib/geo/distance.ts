/** Distance on the earth's surface. Imports nothing: core's registries and modules share it. */

export const EARTH_RADIUS_M = 6371000;

/**
 * Great-circle distance in metres between two points (haversine).
 *
 * `asin`'s argument is clamped to 1: two antipodal or rounding-heavy points can compute a hair
 * over it, and `asin` of that is `NaN` — a distance that then compares false against everything.
 */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}
