/**
 * What phones and trackers post, read into track points: GPRMC, OsmAnd, Traccar Client's JSON and
 * EiN's own, with speed in m/s and a request without a fix read as no points.
 */

import { assertAlmostEquals, assertEquals } from '@std/assert';
import { fromGprmc, fromOsmAnd, fromTraccarJson, readTrackerRequest, type TrackerFixes } from '../tracker-protocols.ts';

const KNOT = 1852 / 3600;

const points = (fixes: TrackerFixes) => {
  if ('error' in fixes) throw new Error(`expected points, got ${fixes.error}`);
  return fixes.points;
};

Deno.test('fromGprmc: a valid fix in degrees, at the sentence time, speed in m/s', () => {
  const [fix] = points(fromGprmc('$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230324,003.1,W'));
  assertAlmostEquals(fix.lat, 48 + 7.038 / 60, 1e-9);
  assertAlmostEquals(fix.lng, 11 + 31 / 60, 1e-9);
  assertEquals(fix.ts, '2024-03-23T12:35:19.000Z');
  assertAlmostEquals(fix.speed!, 22.4 * KNOT, 1e-9);
  assertEquals(fix.course, 84.4);
});

Deno.test('fromGprmc: unpadded longitude degrees and the southern and western hemispheres', () => {
  const [fix] = points(fromGprmc('GPRMC,080000.00,A,3352.50,S,15112.60,W,0,,010125,,'));
  assertAlmostEquals(fix.lat, -(33 + 52.5 / 60), 1e-9);
  assertAlmostEquals(fix.lng, -(151 + 12.6 / 60), 1e-9);
  assertEquals(fix.ts, '2025-01-01T08:00:00.000Z');
  assertEquals(fix.course, undefined);
});

Deno.test('fromGprmc: a void fix is no points, and what is not a sentence is an error', () => {
  assertEquals(fromGprmc('$GPRMC,123519,V,,,,,,,230394,,'), { points: [] });
  assertEquals('error' in fromGprmc('$GPGGA,123519,4807.038,N'), true);
  assertEquals('error' in fromGprmc('$GPRMC,123519,A,,,,,,,230394,,'), true);
});

Deno.test('fromOsmAnd: epoch seconds or milliseconds, speed in knots, bearing and altitude', () => {
  const [fix] = points(fromOsmAnd(new URLSearchParams('id=phone&lat=57.5&lon=11.9&timestamp=1700000000&speed=10&bearing=270&altitude=12.5')));
  assertEquals(fix, { lat: 57.5, lng: 11.9, ts: '2023-11-14T22:13:20.000Z', alt: 12.5, speed: 10 * KNOT, course: 270 });

  const [ms] = points(fromOsmAnd(new URLSearchParams('lat=1&lon=2&timestamp=1700000000123')));
  assertEquals(ms.ts, '2023-11-14T22:13:20.123Z');

  const [dated] = points(fromOsmAnd(new URLSearchParams('lat=1&lon=2&timestamp=2024-06-01 10:00:00Z')));
  assertEquals(dated.ts, '2024-06-01T10:00:00.000Z');
});

Deno.test('fromOsmAnd: a ping without a position is no points, half a position an error', () => {
  assertEquals(fromOsmAnd(new URLSearchParams('id=phone&notificationToken=abc')), { points: [] });
  assertEquals('error' in fromOsmAnd(new URLSearchParams('lat=57.5')), true);
  assertEquals('error' in fromOsmAnd(new URLSearchParams('lat=95&lon=11')), true);
});

Deno.test('fromTraccarJson: speed in m/s, an unknown heading and speed left out', () => {
  const body = {
    device_id: 'phone',
    location: { timestamp: '2024-06-01T10:00:00.000Z', coords: { latitude: 57.5, longitude: 11.9, speed: -1, heading: -1, altitude: 3 } },
  };
  assertEquals(points(fromTraccarJson(body)), [{ lat: 57.5, lng: 11.9, ts: '2024-06-01T10:00:00.000Z', alt: 3 }]);

  const moving = { location: { timestamp: '2024-06-01T10:00:00Z', coords: { latitude: 57.5, longitude: 11.9, speed: 4.2, heading: 90 } } };
  assertEquals(points(fromTraccarJson(moving))[0].speed, 4.2);
  assertEquals(points(fromTraccarJson(moving))[0].course, 90);
});

Deno.test('fromTraccarJson: a list of locations is each of them', () => {
  const at = (minute: number) => ({ timestamp: `2024-06-01T10:0${minute}:00Z`, coords: { latitude: 57.5 + minute / 100, longitude: 11.9 } });
  assertEquals(points(fromTraccarJson({ location: [at(1), at(2)] })).length, 2);
});

Deno.test('readTrackerRequest: each protocol by what the request carries', () => {
  const url = (query = '') => new URL(`http://ein.example/tracker/x.y${query}`);

  const gprmc = points(readTrackerRequest(url('?id=boat&gprmc=$GPRMC,123519,A,4807.038,N,01131.000,E,0,0,230394,,'), '', ''));
  assertEquals(gprmc.length, 1);

  const osmandQuery = points(readTrackerRequest(url('?id=phone&lat=1&lon=2'), '', ''));
  assertEquals(osmandQuery, [{ lat: 1, lng: 2 }]);

  const osmandForm = points(readTrackerRequest(url(), 'application/x-www-form-urlencoded', 'id=phone&lat=3&lon=4&speed=0'));
  assertEquals(osmandForm, [{ lat: 3, lng: 4, speed: 0 }]);

  const traccar = points(readTrackerRequest(url(), 'application/json', JSON.stringify({ location: { coords: { latitude: 5, longitude: 6 } } })));
  assertEquals(traccar, [{ lat: 5, lng: 6 }]);

  const native = points(readTrackerRequest(url(), 'application/json', '{"lat":7,"lng":8}\n{"lat":9,"lng":10}'));
  assertEquals(native, [{ lat: 7, lng: 8 }, { lat: 9, lng: 10 }]);

  assertEquals(readTrackerRequest(url(), 'application/x-www-form-urlencoded', 'id=phone&notificationToken=abc'), { points: [] });
  assertEquals('error' in readTrackerRequest(url(), 'application/json', 'not json {'), true);
});
