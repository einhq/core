/**
 * Turning a run of fixes into drawable segments, and thinning it.
 *
 * Shared by both registry implementations so a memory-backed read and a
 * PostGIS-backed one cut the line in the same locations. PostGIS does the
 * filtering and (with a tolerance) the simplification; the day/gap split is
 * pure arithmetic on timestamps and stays here either way.
 */
import { TrackBounds, TrackPoint, TrackSegment } from './types.ts';

/** Floor on what counts as a pause, for a densely sampled track. */
const DEFAULT_GAP_MS = 30 * 60 * 1000;

/** How many typical intervals a pause has to be, once the track is thinned. */
const GAP_FACTOR = 6;

const dayOf = (ts: string): string => ts.slice(0, 10);

/**
 * What counts as a pause in *these* points.
 *
 * A fixed threshold cannot survive thinning: keep every 32nd point of a track
 * sampled every 1.5s and the points arrive half an hour apart, so a fixed
 * half-hour rule cuts between every pair and the whole track disappears into
 * one-point segments. Scaling by the track's own rhythm keeps a dense track on
 * the floor while a thinned one only breaks where the recording really
 * stopped.
 *
 * The low quartile, not the mean: it describes the sampling rather than being
 * dragged upwards by the very pauses it is meant to find.
 */
function gapThreshold(points: TrackPoint[]): number {
  const intervals: number[] = [];

  for (let i = 1; i < points.length; i++) {
    const a = Date.parse(points[i - 1].ts);
    const b = Date.parse(points[i].ts);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) intervals.push(b - a);
  }

  if (intervals.length === 0) return DEFAULT_GAP_MS;

  intervals.sort((a, b) => a - b);
  return Math.max(DEFAULT_GAP_MS, intervals[Math.floor(intervals.length / 4)] * GAP_FACTOR);
}

/**
 * Cut points into segments on two boundaries: a day, because that is what
 * carries a color, and a pause, because a bbox read returns only what is near
 * the viewport and joining across the hole would draw a line the track never
 * took.
 *
 * A single-point segment is kept. This is the only path a read has, so dropping
 * it would discard the fix itself: a one-point track would read back empty, and
 * an isolated fix would vanish while `truncated` said false. A map draws a
 * one-vertex polyline as nothing, so keeping it costs no pixels.
 */
export function splitSegments(points: TrackPoint[], gapMs: number = gapThreshold(points)): TrackSegment[] {
  const segments: TrackSegment[] = [];
  let previousTime: number | null = null;

  for (const point of points) {
    const day = dayOf(point.ts);
    const time = Date.parse(point.ts);
    const open: TrackSegment | undefined = segments[segments.length - 1];

    const dayChanged = open !== undefined && open.day !== day;
    const gapped = previousTime !== null && Number.isFinite(time) && time - previousTime > gapMs;

    if (open === undefined || dayChanged || gapped) {
      // A segment carried over midnight would leave a hole in the line, so the
      // new one starts on the last point of the old — except across a gap,
      // where the hole is the point.
      const bridge = open !== undefined && dayChanged && !gapped ? open.points[open.points.length - 1] : undefined;
      segments.push({ day, points: bridge ? [bridge, point] : [point] });
    } else {
      open.points.push(point);
    }

    if (Number.isFinite(time)) previousTime = time;
  }

  return segments;
}

/** Widen a box by a fraction of its own size. See `TrackReadOptions.margin`. */
export function expandBounds(bounds: TrackBounds, margin: number): TrackBounds {
  if (margin <= 0) return bounds;

  const dLat = (bounds.north - bounds.south) * margin;
  const dLng = (bounds.east - bounds.west) * margin;

  return {
    north: Math.min(90, bounds.north + dLat),
    south: Math.max(-90, bounds.south - dLat),
    east: bounds.east + dLng,
    west: bounds.west - dLng,
  };
}

/** Whether a point falls inside a box. */
export function inBounds(bounds: TrackBounds, point: { lat: number; lng: number }): boolean {
  return point.lat <= bounds.north && point.lat >= bounds.south && point.lng <= bounds.east && point.lng >= bounds.west;
}

/** Perpendicular distance from `p` to the segment `a`–`b`, in degrees. */
function perpendicular(p: TrackPoint, a: TrackPoint, b: TrackPoint): number {
  const dx = b.lng - a.lng;
  const dy = b.lat - a.lat;

  if (dx === 0 && dy === 0) {
    return Math.hypot(p.lng - a.lng, p.lat - a.lat);
  }

  const t = Math.max(0, Math.min(1, ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / (dx * dx + dy * dy)));

  return Math.hypot(p.lng - (a.lng + t * dx), p.lat - (a.lat + t * dy));
}

/**
 * Douglas–Peucker in planar lon/lat degrees — the same algorithm and the same
 * units as `ST_Simplify`, so the memory registry thins a line the way PostGIS
 * does. Endpoints always survive.
 */
export function simplify(points: TrackPoint[], tolerance: number): TrackPoint[] {
  if (tolerance <= 0 || points.length < 3) return points;

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  // Explicit stack: a long track recurses deeper than the call stack allows.
  const stack: Array<[number, number]> = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let furthest = -1;
    let maxDistance = tolerance;

    for (let i = first + 1; i < last; i++) {
      const distance = perpendicular(points[i], points[first], points[last]);
      if (distance > maxDistance) {
        maxDistance = distance;
        furthest = i;
      }
    }

    if (furthest === -1) continue;

    keep[furthest] = 1;
    stack.push([first, furthest], [furthest, last]);
  }

  return points.filter((_, index) => keep[index] === 1);
}

/**
 * Filtered points to drawable segments: thin per day, cut on day and pause,
 * then cap.
 *
 * Both registries end here, which is what keeps a memory-backed read and a
 * PostGIS-backed one cutting the line in the same locations. The thinning is per
 * *day group* rather than per segment because that is the unit PostGIS can
 * simplify in SQL — `GROUP BY day` over the filtered rows — and the two
 * implementations have to agree. `tolerance: 0` means the caller already
 * simplified (PostGIS did it) and this is only the split.
 */
export function toSegments(points: TrackPoint[], tolerance: number, limit?: number): TrackSegment[] {
  const thinned: TrackPoint[] = [];
  let day: string | undefined;
  let group: TrackPoint[] = [];

  const flush = () => {
    if (group.length > 0) thinned.push(...simplify(group, tolerance));
    group = [];
  };

  for (const point of points) {
    const pointDay = dayOf(point.ts);
    if (pointDay !== day) {
      flush();
      day = pointDay;
    }
    group.push(point);
  }
  flush();

  const segments = splitSegments(thinned);

  return limit === undefined ? segments : capSegments(segments, limit);
}

/**
 * Thin segments down to `limit` vertices in total, each segment keeping its
 * share. Simplification is the good way to lose points; this is the backstop
 * that keeps one pathological track from stalling a map.
 */
export function capSegments(segments: TrackSegment[], limit: number): TrackSegment[] {
  const total = segments.reduce((sum, segment) => sum + segment.points.length, 0);

  if (total <= limit) return segments;

  return segments
    .map((segment) => ({
      day: segment.day,
      points: stride(segment.points, Math.max(2, Math.floor((segment.points.length / total) * limit))),
    }))
    .filter((segment) => segment.points.length > 0);
}

/** Keep at most `limit` points, evenly spaced, endpoints included. */
export function stride(points: TrackPoint[], limit: number): TrackPoint[] {
  if (points.length <= limit || limit < 2) return points;

  const step = points.length / limit;
  const out: TrackPoint[] = [];

  for (let i = 0; i < limit - 1; i++) {
    out.push(points[Math.floor(i * step)]);
  }
  out.push(points[points.length - 1]);

  return out;
}
