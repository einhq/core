/**
 * The pure part of a track read: where a line is cut, and what a thinned line
 * keeps.
 */
import { assertEquals } from '@std/assert';
import { simplify, splitSegments, stride } from '../segment.ts';

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
