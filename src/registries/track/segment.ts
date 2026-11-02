/**
 * Turning a run of fixes into drawable segments, thinning it, and collapsing
 * where it lies still.
 *
 * Shared by both registry implementations so a memory-backed read and a
 * PostGIS-backed one cut the line in the same locations. PostGIS does the
 * filtering and (with a tolerance) the simplification; collapsing still
 * periods and the day/gap split stay here either way.
 */
import { haversineMeters } from '../../lib/geo/distance.ts';
import { TrackBounds, TrackPoint, TrackSegment, TrackStillOptions } from './types.ts';

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

const KNOT_MPS = 1852 / 3600;

/** The default `TrackStillOptions.maxSpeed`, in m/s. */
export const STILL_MAX_SPEED = 50 * KNOT_MPS;

const STILL_DEFAULTS: Required<TrackStillOptions> = {
  radius: 80,
  minMs: 15 * 60_000,
  stillSpeed: 0.5 * KNOT_MPS,
  maxSpeed: STILL_MAX_SPEED,
};

/** An excursion from a stay that comes back within this long is drift, not a departure... */
const RETURN_MS = 10 * 60_000;

/** ...unless it gets this many metres from the stay's centroid. */
const ESCAPE_M = 300;

/** Fixes rejected as spikes for longer than this mean the jump was real: a gap, or a reboot. */
const SPIKE_MAX_MS = 30_000;

/**
 * A point without a speed is given one measured over this long. Between fixes seconds apart, a few
 * metres of jitter reads as walking pace.
 */
const SPEED_WINDOW_MS = 5 * 60_000;

/** A point with its time in ms and its speed in m/s, recorded or derived. */
type Fix = { point: TrackPoint; ms: number; speed: number | null };

const distance = (a: TrackPoint, b: TrackPoint): number => haversineMeters(a.lat, a.lng, b.lat, b.lng);

/** Speed in m/s implied by travelling between two fixes. */
function impliedSpeed(a: Fix, b: Fix): number {
  const dt = b.ms - a.ms;
  return dt <= 0 ? Infinity : distance(a.point, b.point) / (dt / 1000);
}

/**
 * Drop fixes whose implied speed from the last accepted fix exceeds `maxSpeed`.
 *
 * Measuring from the last *accepted* fix also drops a cluster of glitches that
 * agree with each other but not with the track. Once fixes have been rejected
 * for longer than `SPIKE_MAX_MS` the jump is taken as real.
 */
function dropSpikes(fixes: Fix[], maxSpeed: number): Fix[] {
  if (fixes.length < 2) return fixes;

  const out: Fix[] = [fixes[0]];
  let rejectedSince: number | null = null;

  for (let i = 1; i < fixes.length; i++) {
    const fix = fixes[i];
    if (impliedSpeed(out[out.length - 1], fix) <= maxSpeed || (rejectedSince !== null && fix.ms - rejectedSince > SPIKE_MAX_MS)) {
      out.push(fix);
      rejectedSince = null;
    } else if (rejectedSince === null) {
      rejectedSince = fix.ms;
    }
  }

  return out;
}

/**
 * Drop each fix reached and left at more than `maxSpeed`, judged against its neighbours alone.
 *
 * A still read does this first, on every point it filtered, before simplifying: thinned out, a
 * spike's neighbours can be minutes away and the jump to it no longer looks fast to
 * `collapseStill`. Judged neighbour by neighbour it is what a window function can say, so PostGIS
 * does the same in SQL; a cluster of glitches is left to `collapseStill`.
 */
export function dropLoneSpikes(points: TrackPoint[], maxSpeed: number = STILL_MAX_SPEED): TrackPoint[] {
  const fixes = points.map((point) => ({ point, ms: Date.parse(point.ts), speed: null }));
  return points.filter((_, i) => !(i > 0 && i < fixes.length - 1 && impliedSpeed(fixes[i - 1], fixes[i]) > maxSpeed && impliedSpeed(fixes[i], fixes[i + 1]) > maxSpeed));
}

/**
 * Give each fix without a recorded speed one measured over `SPEED_WINDOW_MS`: from the last fix
 * that long before it and to the first fix that long after it, whichever is slower. Looking both
 * ways keeps a fix that has just arrived from carrying the approach's speed, and one about to
 * leave from carrying the departure's.
 */
function deriveSpeeds(fixes: Fix[]): void {
  const speeds = fixes.map((fix, i) => {
    if (fix.speed !== null) return fix.speed;

    let before = i - 1;
    while (before > 0 && fixes[before].ms > fix.ms - SPEED_WINDOW_MS) before--;
    let after = i + 1;
    while (after < fixes.length - 1 && fixes[after].ms < fix.ms + SPEED_WINDOW_MS) after++;

    const slowest = Math.min(
      before >= 0 ? impliedSpeed(fixes[before], fix) : Infinity,
      after < fixes.length ? impliedSpeed(fix, fixes[after]) : Infinity,
    );
    return Number.isFinite(slowest) ? slowest : null;
  });

  speeds.forEach((speed, i) => fixes[i].speed = speed);
}

function medianSpeed(fixes: Fix[]): number | null {
  const speeds = fixes.map((fix) => fix.speed).filter((speed): speed is number => speed !== null).sort((a, b) => a - b);
  if (speeds.length === 0) return null;
  const middle = speeds.length >> 1;
  return speeds.length % 2 ? speeds[middle] : (speeds[middle - 1] + speeds[middle]) / 2;
}

/**
 * Hide what a device draws while it lies still: GPS drift around a berth,
 * spikes far out, and excursions that snap back.
 *
 * Spikes go first (`dropSpikes`). Then a stay-point machine walks the time-ordered
 * fixes. Moving, fixes gather in a window around its rolling centroid: a fix
 * outside `radius` flushes the window unchanged, and staying `minMs` within it
 * makes a stay. During a stay, a fix outside the radius looks ahead: if the
 * track comes back within `RETURN_MS` without getting `ESCAPE_M` away, the fixes
 * out there are dropped; otherwise the stay ends.
 *
 * An ended stay gives its moving edges back to the track (leading fixes still
 * arriving, trailing ones already leaving), and is a stay only if what is left
 * still spans `minMs` at a median speed of `stillSpeed` or less. It is drawn as
 * two points on its centroid, at arrival and at departure, so the line ends on
 * the berth and later leaves from it. They carry speed 0 when the stay's fixes
 * recorded a speed.
 *
 * A point without a recorded speed (every point of a simplified read) is given
 * one measured from the points around it.
 */
export function collapseStill(points: TrackPoint[], options: TrackStillOptions = {}): TrackPoint[] {
  const { radius, minMs, stillSpeed, maxSpeed } = { ...STILL_DEFAULTS, ...options };

  const fixes = dropSpikes(points.map((point) => ({ point, ms: Date.parse(point.ts), speed: point.speed ?? null })), maxSpeed);
  if (fixes.length < 2) return fixes.map((fix) => fix.point);
  deriveSpeeds(fixes);

  const out: TrackPoint[] = [];
  const emit = (run: Fix[]) => {
    for (const fix of run) out.push(fix.point);
  };

  let window: Fix[] = [];
  let sumLat = 0;
  let sumLng = 0;
  let stopped = false;

  const add = (fix: Fix) => {
    window.push(fix);
    sumLat += fix.point.lat;
    sumLng += fix.point.lng;
  };
  const reset = () => {
    window = [];
    sumLat = 0;
    sumLng = 0;
    stopped = false;
  };

  const closeStay = () => {
    let a = 0;
    let b = window.length - 1;
    while (a < b && window[a].speed !== null && window[a].speed! > stillSpeed) a++;
    while (b > a && window[b].speed !== null && window[b].speed! > stillSpeed) b--;

    const core = window.slice(a, b + 1);
    const median = medianSpeed(core);
    const still = core.length > 1 && core[core.length - 1].ms - core[0].ms >= minMs && (median === null || median <= stillSpeed);

    if (!still) {
      emit(window);
    } else {
      emit(window.slice(0, a));
      const lat = core.reduce((sum, fix) => sum + fix.point.lat, 0) / core.length;
      const lng = core.reduce((sum, fix) => sum + fix.point.lng, 0) / core.length;
      const recorded = core.some((fix) => fix.point.speed !== undefined);
      for (const fix of [core[0], core[core.length - 1]]) {
        out.push(recorded ? { lat, lng, ts: fix.point.ts, speed: 0 } : { lat, lng, ts: fix.point.ts });
      }
      emit(window.slice(b + 1));
    }

    reset();
  };

  add(fixes[0]);
  let i = 1;

  while (i < fixes.length) {
    const fix = fixes[i];
    const lat = sumLat / window.length;
    const lng = sumLng / window.length;
    const fromCentroid = (other: Fix) => haversineMeters(lat, lng, other.point.lat, other.point.lng);
    const away = fromCentroid(fix);

    if (!stopped) {
      if (away <= radius) {
        add(fix);
        if (fix.ms - window[0].ms >= minMs) stopped = true;
      } else {
        emit(window);
        reset();
        add(fix);
      }
      i++;
    } else if (away <= radius) {
      add(fix);
      i++;
    } else {
      let back = -1;
      for (let j = i; j < fixes.length && fixes[j].ms - fix.ms <= RETURN_MS; j++) {
        const d = fromCentroid(fixes[j]);
        if (d > ESCAPE_M) break;
        if (d <= radius) {
          back = j;
          break;
        }
      }

      if (back >= 0) {
        i = back;
      } else {
        closeStay();
        add(fix);
        i++;
      }
    }
  }

  if (stopped) closeStay();
  else emit(window);

  return out;
}

/**
 * Filtered points to drawable segments: thin per day, collapse still periods
 * when asked, then cut on day and pause.
 *
 * Both registries end here, which is what keeps a memory-backed read and a
 * PostGIS-backed one cutting the line in the same locations. The thinning is per
 * *day group* rather than per segment because that is the unit PostGIS can
 * simplify in SQL — `GROUP BY day` over the filtered rows — and the two
 * implementations have to agree. `tolerance: 0` means the caller already
 * simplified (PostGIS did it). `still` collapses after the thinning, on the
 * points that will be drawn, so both registries collapse the same points.
 */
export function toSegments(points: TrackPoint[], tolerance: number, still?: TrackStillOptions): TrackSegment[] {
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

  return splitSegments(still ? collapseStill(thinned, still) : thinned);
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
