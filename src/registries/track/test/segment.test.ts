/**
 * The pure part of a track read: where a line is cut, what a thinned line
 * keeps, and what a still read collapses.
 */
import { assert, assertEquals } from '@std/assert';
import { collapseStill, simplify, splitSegments, stride, toSegments } from '../segment.ts';
import type { TrackPoint } from '../types.ts';

const point = (ts: string, lng: number) => ({ lat: 57.7, lng, ts });

Deno.test('track segments: a day boundary cuts, without leaving a hole', () => {
  const segments = splitSegments([
    point('2015-08-16T23:58:00Z', 11.0),
    point('2015-08-16T23:59:00Z', 11.1),
    point('2015-08-17T00:00:00Z', 11.2),
    point('2015-08-17T00:01:00Z', 11.3),
  ]);

  assertEquals(segments.map((s) => s.day), ['2015-08-16', '2015-08-17']);
  // The new day starts on the old day's last point, so the two colored lines meet.
  assertEquals(segments[0].points.at(-1)?.lng, 11.1);
  assertEquals(segments[1].points[0].lng, 11.1);
});

Deno.test('track segments: a gap cuts and does not bridge', () => {
  const segments = splitSegments([
    point('2015-08-16T10:00:00Z', 11.0),
    point('2015-08-16T10:01:00Z', 11.1),
    // Two hours later and far away — a bbox clip, or a tracker switched off.
    point('2015-08-16T12:01:00Z', 12.9),
    point('2015-08-16T12:02:00Z', 13.0),
  ]);

  assertEquals(segments.length, 2);
  assertEquals(segments.every((s) => s.day === '2015-08-16'), true);
  // No bridging point: the line must not draw the shortcut it never took.
  assertEquals(segments[1].points.map((p) => p.lng), [12.9, 13.0]);
});

Deno.test('track segments: an ordinary stop is not a gap', () => {
  const segments = splitSegments([
    point('2015-08-16T10:00:00Z', 11.0),
    point('2015-08-16T10:20:00Z', 11.0),
    point('2015-08-16T10:29:00Z', 11.1),
  ]);

  assertEquals(segments.length, 1);
  assertEquals(segments[0].points.length, 3);
});

Deno.test('track segments: thinning a track does not shred it', () => {
  // Simplify a track sampled every 1.5s and the survivors can land ~48 min
  // apart. A fixed half-hour rule would cut between every pair, and every
  // segment would end up one point long.
  const points = Array.from({ length: 12 }, (_, i) => ({
    lat: 57.7 + i * 0.01,
    lng: 11.0 + i * 0.01,
    ts: new Date(Date.parse('2015-08-17T00:00:00Z') + i * 48 * 60 * 1000).toISOString(),
  }));

  const segments = splitSegments(points);
  assertEquals(segments.length, 1);
  assertEquals(segments[0].points.length, 12);

  // A real stop is still a stop: 16 hours off is a pause in anyone's book, even
  // where the sampling itself is 48 minutes.
  const withStop = [
    ...points.slice(0, 6),
    { lat: 57.9, lng: 11.5, ts: '2015-08-17T20:00:00Z' },
    { lat: 57.91, lng: 11.51, ts: '2015-08-17T20:48:00Z' },
  ];
  assertEquals(splitSegments(withStop).length, 2);
});

Deno.test('track segments: a lone point is kept as a segment of its own', () => {
  // One vertex draws nothing, but this is the only path a read has: a track
  // holding a single fix reads back that fix.
  assertEquals(splitSegments([point('2015-08-16T10:00:00Z', 11.0)]).length, 1);
  assertEquals(splitSegments([]), []);

  // ...and an isolated fix in the middle of a track stays. The pause still
  // cuts, so it is a segment of its own rather than joined across.
  const segments = splitSegments([
    point('2015-08-16T10:00:00Z', 11.0),
    point('2015-08-16T14:00:00Z', 12.0),
    point('2015-08-16T14:01:00Z', 12.1),
  ]);
  assertEquals(segments.length, 2);
  assertEquals(segments[0].points.map((p) => p.lng), [11.0]);
  assertEquals(segments[1].points.map((p) => p.lng), [12.0, 12.1]);
});

Deno.test('simplify: a straight line collapses to its ends, a corner survives', () => {
  const line = Array.from({ length: 9 }, (_, i) => point(`2015-08-16T10:0${i}:00Z`, 11.0 + i * 0.1));

  assertEquals(simplify(line, 0.5).map((p) => p.lng), [11.0, 11.8]);

  const corner = [
    { lat: 57.7, lng: 11.0, ts: '2015-08-16T10:00:00Z' },
    { lat: 57.7, lng: 12.0, ts: '2015-08-16T10:01:00Z' },
    { lat: 58.7, lng: 12.0, ts: '2015-08-16T10:02:00Z' },
  ];
  assertEquals(simplify(corner, 0.1).length, 3);

  // A tolerance of zero is a no-op, and so is a line too short to thin.
  assertEquals(simplify(line, 0).length, 9);
  assertEquals(simplify(line.slice(0, 2), 5).length, 2);
});

Deno.test('stride: keeps the ends and the count', () => {
  const line = Array.from({ length: 100 }, (_, i) => point(new Date(Date.parse('2015-08-16T10:00:00Z') + i * 1000).toISOString(), 11 + i * 0.001));
  const strided = stride(line, 10);

  assertEquals(strided.length, 10);
  assertEquals(strided[0], line[0]);
  assertEquals(strided.at(-1), line.at(-1));
  assertEquals(stride(line, 200).length, 100);
});

// Still reads, on a berth at an invented position; distances run north of it.
const BERTH_LAT = 57.7;
const M_DEG = 1 / 111_320;
const SEC = 1000;
const MIN = 60 * SEC;
const BERTH_T0 = Date.parse('2015-07-01T10:00:00.000Z');
const KNOT = 1852 / 3600;

/** A fix `ms` after the start, `north` metres north of the berth, at `knots` (or none recorded). */
const fix = (ms: number, north: number, knots?: number): TrackPoint => ({
  lat: BERTH_LAT + north * M_DEG,
  lng: 11.97,
  ts: new Date(BERTH_T0 + ms).toISOString(),
  ...(knots === undefined ? {} : { speed: knots * KNOT }),
});
const northOf = (point: TrackPoint) => (point.lat - BERTH_LAT) / M_DEG;
const stays = (points: TrackPoint[]) => points.filter((point) => point.speed === 0);

Deno.test('still: drift on a berth becomes an arrival and a departure on its centroid', () => {
  const points = Array.from({ length: 21 }, (_, i) => fix(i * MIN, ((i % 3) - 1) * 11, 0.1));
  const out = collapseStill(points);

  assertEquals(out.length, 2);
  assertEquals(out.map((point) => point.ts), [points[0].ts, points[20].ts]);
  assertEquals(out.map((point) => point.speed), [0, 0]);
  assertEquals(out[0].lat, out[1].lat);
  assert(Math.abs(northOf(out[0])) < 5);
});

Deno.test('still: a steady passage is left alone', () => {
  const points = Array.from({ length: 10 }, (_, i) => fix(i * MIN, i * 111, 3.6));
  assertEquals(collapseStill(points), points);
});

Deno.test('still: an excursion that comes straight back is dropped', () => {
  const points = [
    ...Array.from({ length: 21 }, (_, i) => fix(i * MIN, 0, 0.1)),
    ...Array.from({ length: 3 }, (_, i) => fix((21 + i) * MIN, 150, 1)),
    ...Array.from({ length: 22 }, (_, i) => fix((24 + i) * MIN, 0, 0.1)),
  ];
  const out = collapseStill(points);

  assertEquals(out.length, 2);
  assert(out.every((point) => Math.abs(northOf(point)) < 80));
});

Deno.test('still: the approach and the departure are kept around the stay', () => {
  const points = [
    ...Array.from({ length: 7 }, (_, i) => fix(i * MIN, 350 - i * 50, 2)),
    ...Array.from({ length: 21 }, (_, i) => fix((7 + i) * MIN, 0, 0.1)),
    ...Array.from({ length: 7 }, (_, i) => fix((28 + i) * MIN, (i + 1) * 50, 2)),
  ];
  const out = collapseStill(points);
  const [arrival, departure] = stays(out);

  assertEquals(stays(out).length, 2);
  assert(Math.abs(northOf(arrival)) < 10);
  const before = out.slice(0, out.indexOf(arrival)).map(northOf);
  const after = out.slice(out.indexOf(departure) + 1).map(northOf);
  for (const metres of [350, 300, 250, 200, 150, 100, 50]) {
    assert(before.some((north) => Math.abs(north - metres) < 0.01), `approach fix at ${metres} m`);
    assert(after.some((north) => Math.abs(north - metres) < 0.01), `departure fix at ${metres} m`);
  }
});

Deno.test('still: moving to a second berth is two stays with the passage between', () => {
  const points = [
    ...Array.from({ length: 21 }, (_, i) => fix(i * MIN, 0, 0.1)),
    ...Array.from({ length: 4 }, (_, i) => fix((21 + i) * MIN, (i + 1) * 100, 2)),
    ...Array.from({ length: 21 }, (_, i) => fix((25 + i) * MIN, 400, 0.1)),
  ];
  const out = collapseStill(points);

  assertEquals(stays(out).map((point) => Math.round(northOf(point) / 100) * 100), [0, 0, 400, 400]);
  assert(out.some((point) => point.speed !== 0 && northOf(point) > 50 && northOf(point) < 350));
});

Deno.test('still: a stay across midnight arrives on one day and leaves on the next', () => {
  const midnight = Date.parse('2015-07-02T00:00:00.000Z') - BERTH_T0;
  const points = Array.from({ length: 25 }, (_, i) => fix(midnight - 60 * MIN + i * 5 * MIN, 0, 0.1));
  const segments = toSegments(points, 0, {});

  assertEquals(segments.map((segment) => segment.day), ['2015-07-01', '2015-07-02']);
  assertEquals(segments.flatMap((segment) => segment.points).length, 3);
});

Deno.test('still: fixes without a speed are measured, so a slow circle in the radius is no stay', () => {
  // Round and round a 60 m circle, a lap every three minutes: within the radius for half an hour,
  // but moving at about 2 m/s.
  const circling = Array.from({ length: 61 }, (_, i) => {
    const angle = (i / 6) * 2 * Math.PI;
    return {
      lat: BERTH_LAT + 60 * Math.sin(angle) * M_DEG,
      lng: 11.97 + (60 * Math.cos(angle) * M_DEG) / Math.cos(BERTH_LAT * Math.PI / 180),
      ts: new Date(BERTH_T0 + i * 30 * SEC).toISOString(),
    };
  });
  assertEquals(collapseStill(circling).length, circling.length);

  // Drifting on the berth at the same rhythm, a fix every 30 s, with no speed recorded.
  const drifting = Array.from({ length: 61 }, (_, i) => fix(i * 30 * SEC, ((i % 3) - 1) * 8));
  const out = collapseStill(drifting);
  assertEquals(out.length, 2);
  assertEquals(out[0].speed, undefined);
});

Deno.test('still: a single spike is dropped', () => {
  const points = Array.from({ length: 10 }, (_, i) => fix(i * 5 * SEC, i === 5 ? 5000 : i * 10, 3.9));
  const out = collapseStill(points);

  assertEquals(out.length, 9);
  assert(out.every((point) => northOf(point) < 100));
});

Deno.test('still: a cluster of spikes agreeing with each other is dropped', () => {
  const points = Array.from({ length: 25 }, (_, i) => fix(i * 5 * SEC, i >= 13 && i <= 15 ? 500 : i * 2, 0.5));
  const out = collapseStill(points, { minMs: 60 * MIN });

  assertEquals(out.length, points.length - 3);
  assert(out.every((point) => northOf(point) < 100));
});

Deno.test('still: a jump that persists is taken after half a minute', () => {
  const points = [
    ...Array.from({ length: 7 }, (_, i) => fix(i * 5 * SEC, 0, 0.1)),
    ...Array.from({ length: 18 }, (_, i) => fix((7 + i) * 5 * SEC, 10_000, 0.1)),
  ];
  const out = collapseStill(points, { minMs: 60 * MIN });
  const there = out.filter((point) => northOf(point) > 9000);

  assert(there.length > 0);
  assert(Date.parse(there[0].ts) - Date.parse(points[7].ts) > 30 * SEC);
});

Deno.test('still: a higher maximum speed keeps a fast jump', () => {
  // 1 km in 10 s is 100 m/s: a glitch for a boat, not for a plane.
  const points = [fix(0, 0, 0), fix(10 * SEC, 1000, 0), fix(20 * SEC, 2000, 0)];

  assertEquals(collapseStill(points).length, 1);
  assertEquals(collapseStill(points, { maxSpeed: 150 }).length, 3);
});
