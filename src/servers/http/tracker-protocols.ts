/**
 * What phones and GPS trackers post, read into track points.
 *
 * - Traccar Client's JSON body: `{location: {coords: {latitude, longitude, speed, heading,
 *   altitude}, timestamp}}`, or `location` as a list of them; speed in m/s, a heading of −1 unknown.
 * - The OsmAnd protocol, as a query or a form body: `lat`, `lon`, `timestamp` (epoch seconds or
 *   milliseconds, or a date), `speed` in knots, `bearing`, `altitude`.
 * - A GPRMC sentence over HTTP: `?gprmc=$GPRMC,…`, speed in knots.
 * - EiN's own points, as `POST /track` takes them: a JSON object, a JSON list, or one object a
 *   line, each `{lat, lng, ts?, alt?, speed?, course?}`.
 *
 * Speed is kept in m/s and course in degrees. A request that carries no fix — Traccar Client's
 * registration ping, a GPRMC sentence marked void — reads as no points, which is not an error.
 */

import type { TrackPointInput } from '../../registries/track/mod.ts';

const KNOT_MS = 1852 / 3600;

/** The points a request carries, or why it carries none that could be read. */
export type TrackerFixes = { points: TrackPointInput[] } | { error: string };

const finite = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

const onEarth = (lat: number, lng: number): boolean => Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/** A point with `alt`, `speed` and `course` only where they are known. */
const point = (lat: number, lng: number, ts: string | undefined, extra: { alt?: number; speed?: number; course?: number }): TrackPointInput => ({
  lat,
  lng,
  ...(ts !== undefined ? { ts } : {}),
  ...(extra.alt !== undefined ? { alt: extra.alt } : {}),
  ...(extra.speed !== undefined ? { speed: extra.speed } : {}),
  ...(extra.course !== undefined ? { course: extra.course } : {}),
});

/** A tracker's time: epoch seconds or milliseconds, or a date; undefined for none or one that does not parse. */
const trackerTime = (raw: unknown): string | undefined => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const text = String(raw).trim();
  const at = /^\d+(\.\d+)?$/.test(text) ? (Number(text) < 1e12 ? Number(text) * 1000 : Number(text)) : Date.parse(text);
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
};

/**
 * An NMEA coordinate (`ddmm.mmmm`, `dddmm.mmmm`, zero-padded or not) and its hemisphere, in signed
 * degrees: the two digits before the point are the minutes, everything before them the degrees.
 */
const nmeaCoordinate = (raw: string | undefined, hemisphere: string | undefined): number | undefined => {
  if (!raw) return undefined;
  const whole = raw.split('.')[0];
  if (whole.length < 3) return undefined;
  const degrees = Number(whole.slice(0, -2));
  const minutes = Number(raw.slice(whole.length - 2));
  if (!Number.isFinite(degrees) || !Number.isFinite(minutes)) return undefined;
  const value = degrees + minutes / 60;
  return hemisphere === 'S' || hemisphere === 'W' ? -value : value;
};

/**
 * A GPRMC sentence: one point, none for a void (`V`) fix, or an error for anything that is not a
 * readable sentence. The time is the sentence's own (DDMMYY, HHMMSS), since a tracker uploads what
 * it buffered while offline.
 */
export const fromGprmc = (sentence: string): TrackerFixes => {
  const fields = sentence.trim().split('*')[0].split(',');
  if (fields[0] !== '$GPRMC' && fields[0] !== 'GPRMC') return { error: 'not a GPRMC sentence' };
  if (fields[2] === 'V') return { points: [] };
  if (fields[2] !== 'A') return { error: 'GPRMC sentence without a fix status' };

  const lat = nmeaCoordinate(fields[3], fields[4]);
  const lng = nmeaCoordinate(fields[5], fields[6]);
  const time = /^(\d{2})(\d{2})(\d{2}(\.\d+)?)/.exec(fields[1] ?? '');
  const date = /^(\d{2})(\d{2})(\d{2})$/.exec(fields[9] ?? '');
  if (lat === undefined || lng === undefined || !onEarth(lat, lng)) return { error: 'GPRMC sentence without a position' };
  if (!time || !date) return { error: 'GPRMC sentence without a date and time' };

  const ts = new Date(`20${date[3]}-${date[2]}-${date[1]}T${time[1]}:${time[2]}:${time[3]}Z`);
  if (Number.isNaN(ts.getTime())) return { error: 'GPRMC sentence without a date and time' };
  const knots = finite(fields[7]);
  return { points: [point(lat, lng, ts.toISOString(), { speed: knots === undefined ? undefined : knots * KNOT_MS, course: finite(fields[8]) })] };
};

/** OsmAnd's parameters, from a query or a form body: one point, or none for a ping without `lat` and `lon`. */
export const fromOsmAnd = (params: URLSearchParams): TrackerFixes => {
  const lat = finite(params.get('lat'));
  const lng = finite(params.get('lon') ?? params.get('lng'));
  if (lat === undefined && lng === undefined) return { points: [] };
  if (lat === undefined || lng === undefined || !onEarth(lat, lng)) return { error: 'lat and lon have to be a position' };

  const knots = finite(params.get('speed'));
  return {
    points: [point(lat, lng, trackerTime(params.get('timestamp')), {
      alt: finite(params.get('altitude')),
      speed: knots === undefined ? undefined : knots * KNOT_MS,
      course: finite(params.get('bearing') ?? params.get('heading')),
    })],
  };
};

/** One Traccar Client location: a point, undefined for one without coordinates, or an error. */
const traccarLocation = (location: unknown): TrackPointInput | undefined | { error: string } => {
  const coords = (location as { coords?: Record<string, unknown> } | undefined)?.coords;
  if (!coords || typeof coords !== 'object') return undefined;
  const lat = finite(coords.latitude);
  const lng = finite(coords.longitude);
  if (lat === undefined || lng === undefined || !onEarth(lat, lng)) return { error: 'location.coords has no position' };

  const speed = finite(coords.speed);
  const heading = finite(coords.heading);
  return point(lat, lng, trackerTime((location as { timestamp?: unknown }).timestamp), {
    alt: finite(coords.altitude),
    speed: speed !== undefined && speed >= 0 ? speed : undefined,
    course: heading !== undefined && heading >= 0 ? heading : undefined,
  });
};

/** Traccar Client's JSON body: its location, or each of a list of them; none for a body without one. */
export const fromTraccarJson = (body: Record<string, unknown>): TrackerFixes => {
  const locations = Array.isArray(body.location) ? body.location : [body.location ?? body];
  const points: TrackPointInput[] = [];
  for (const location of locations) {
    const read = traccarLocation(location);
    if (read && 'error' in read) return read;
    if (read) points.push(read);
  }
  return { points };
};

/** EiN's own points: a JSON object, a JSON list, or one object a line. */
export const fromNative = (text: string): TrackerFixes => {
  let entries: unknown[];
  try {
    const parsed = JSON.parse(text);
    entries = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    try {
      entries = text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
    } catch {
      return { error: 'invalid JSON body' };
    }
  }
  return { points: entries as TrackPointInput[] };
};

/** Whether a parsed JSON body is Traccar Client's rather than EiN's own points. */
const isTraccarBody = (body: unknown): body is Record<string, unknown> =>
  typeof body === 'object' && body !== null && !Array.isArray(body) && ('location' in body || 'coords' in body || 'device_id' in body);

/**
 * Whatever protocol a request speaks, its points: a GPRMC sentence in `gprmc`, then a JSON body
 * (Traccar Client's, or EiN's own), then OsmAnd's parameters from the form body and the query.
 */
export const readTrackerRequest = (url: URL, contentType: string, body: string): TrackerFixes => {
  const form = contentType.includes('application/x-www-form-urlencoded') ? new URLSearchParams(body) : undefined;
  const gprmc = url.searchParams.get('gprmc') ?? form?.get('gprmc');
  if (gprmc) return fromGprmc(gprmc);

  if (!form && body.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return fromNative(body);
    }
    return isTraccarBody(parsed) ? fromTraccarJson(parsed) : fromNative(body);
  }

  const params = new URLSearchParams(url.searchParams);
  for (const [key, value] of form ?? []) params.set(key, value);
  return fromOsmAnd(params);
};
