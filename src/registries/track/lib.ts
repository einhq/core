/** Small helpers shared by both track registry implementations. */
import { TrackPoint, TrackPointInput, TrackSegment, TrackSummary } from './types.ts';

/**
 * Default widening of a viewport read, as a fraction of the box.
 * See `TrackReadOptions.margin` for why a read goes outside the box at all.
 */
export const DEFAULT_MARGIN = 0.25;

/**
 * Validate incoming points and put them in timestamp order.
 *
 * A point without a timestamp gets `now` — a live tracker that only sends
 * coordinates still lands somewhere sensible, and `ts` is the primary key so it
 * cannot be left unset.
 */
export function normalizePoints(points: TrackPointInput[]): TrackPoint[] {
  const out: TrackPoint[] = [];

  for (const raw of points) {
    const lat = Number(raw?.lat);
    const lng = Number(raw?.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error('point needs numeric lat and lng');
    }

    const ts = raw.ts === undefined ? new Date() : new Date(raw.ts);

    if (Number.isNaN(ts.getTime())) {
      throw new Error(`invalid ts: ${raw.ts}`);
    }

    const point: TrackPoint = { lat, lng, ts: ts.toISOString() };

    for (const key of ['alt', 'speed', 'course'] as const) {
      const value = Number(raw[key]);
      if (raw[key] !== undefined && Number.isFinite(value)) point[key] = value;
    }

    out.push(point);
  }

  return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/**
 * Normalize a range bound to a full ISO timestamp.
 *
 * The memory registry compares timestamps as strings, which only works when
 * they are in the same form: `2015-07-04T10:00:00Z` sorts *after*
 * `2015-07-04T10:00:00.000Z` because `Z` beats `.`, so an un-normalized bound
 * silently filters out everything.
 */
export function normalizeTime(value: string | undefined, what: string): string | undefined {
  if (value === undefined) return undefined;

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`invalid ${what}: ${value}`);
  }

  return parsed.toISOString();
}

/** A simplified read carries position and time only. */
export const stripDetail = ({ lat, lng, ts }: TrackPoint): TrackPoint => ({ lat, lng, ts });

export const countPoints = (segments: TrackSegment[]): number => segments.reduce((sum, segment) => sum + segment.points.length, 0);

/** Point count, time span and extent of an ordered run of points. */
export function summarize(points: TrackPoint[]): TrackSummary {
  const summary: TrackSummary = { points: points.length };

  for (const point of points) {
    summary.bbox = summary.bbox
      ? {
        north: Math.max(summary.bbox.north, point.lat),
        south: Math.min(summary.bbox.south, point.lat),
        east: Math.max(summary.bbox.east, point.lng),
        west: Math.min(summary.bbox.west, point.lng),
      }
      : { north: point.lat, south: point.lat, east: point.lng, west: point.lng };

    if (summary.firstTs === undefined || point.ts < summary.firstTs) summary.firstTs = point.ts;
    if (summary.lastTs === undefined || point.ts > summary.lastTs) summary.lastTs = point.ts;
  }

  return summary;
}
