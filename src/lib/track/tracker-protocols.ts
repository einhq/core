/**
 * What phones and GPS trackers send, read into track points: the raw input core's `tracker` driver
 * takes for a device's track.
 *
 * - Traccar Client's JSON body: `{location: {coords: {latitude, longitude, speed, heading,
 *   altitude, accuracy}, timestamp, battery: {level, is_charging}, activity: {type}}}`, or
 *   `location` as a list of them; speed in m/s, a heading of −1 unknown, the battery's level a
 *   fraction.
 * - The OsmAnd protocol, as a query or a form body: `lat`, `lon`, `timestamp` (epoch seconds or
 *   milliseconds, or a date), `speed` in knots, `bearing`, `altitude`, `accuracy`, `batt` in
 *   percent, `charge`.
 * - A GPRMC sentence over HTTP: `?gprmc=$GPRMC,…`, speed in knots.
 * - A GPX document, as a logger or a phone app saves it: its fixes that have a time.
 * - EiN's own points: a JSON object, a JSON list, or one object a line, each
 *   `{lat, lng, ts?, alt?, speed?, course?, accuracy?}`, and what the device said of itself when it
 *   took it: `battery?` in percent, `charging?`, `activity?` (Traccar Client's names).
 *
 * Speed is kept in m/s, course in degrees and accuracy in metres. A request that carries no fix —
 * Traccar Client's registration ping, a GPRMC sentence marked void — reads as no points, which is
 * not an error. What the device said of itself is its `status`: the newest it gave, with or
 * without a fix.
 */

import type { TrackPointInput } from '../../registries/track/mod.ts';
import { isGpx, parseGpx, timedPoints } from './gpx.ts';

const KNOT_MS = 1852 / 3600;

/**
 * What a device said of itself: its battery's charge in percent, whether it is charging, and what
 * it is doing (`still`, `on_foot`, `in_vehicle`, …), as its phone's motion sensors tell; with the
 * time it said so, when it did.
 */
export type TrackerStatus = { battery?: number; charging?: boolean; activity?: string; ts?: string };

/** The points a request carries and what the device said of itself, or why it carries none that could be read. */
export type TrackerFixes = { points: TrackPointInput[]; status?: TrackerStatus } | { error: string };

const finite = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

const onEarth = (lat: number, lng: number): boolean => Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

type Extra = { alt?: number; speed?: number; course?: number; accuracy?: number };

/** A point with `alt`, `speed`, `course` and `accuracy` only where they are known. */
const point = (lat: number, lng: number, ts: string | undefined, extra: Extra): TrackPointInput => ({
  lat,
  lng,
  ...(ts !== undefined ? { ts } : {}),
  ...(extra.alt !== undefined ? { alt: extra.alt } : {}),
  ...(extra.speed !== undefined ? { speed: extra.speed } : {}),
  ...(extra.course !== undefined ? { course: extra.course } : {}),
  ...(extra.accuracy !== undefined && extra.accuracy > 0 ? { accuracy: extra.accuracy } : {}),
});

/** A flag as a tracker sends it: `true`, `1`, `false`, `0`; undefined for anything else. */
const flag = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').trim().toLowerCase();
  return text === 'true' || text === '1' ? true : text === 'false' || text === '0' ? false : undefined;
};

/** A battery's charge in whole percent, from 0 to 100; undefined for none or one out of range, as −1 for unknown. */
const percent = (value: number | undefined): number | undefined => value !== undefined && value >= 0 && value <= 100 ? Math.round(value) : undefined;

/** A status with only what is known in it; undefined when nothing is. */
const statusOf = (status: TrackerStatus): TrackerStatus | undefined => {
  const known = Object.fromEntries(Object.entries(status).filter(([, value]) => value !== undefined)) as TrackerStatus;
  return Object.keys(known).some((key) => key !== 'ts') ? known : undefined;
};

/** The newest of what a device said of itself, a status without a time the newest of all. */
const newest = (statuses: (TrackerStatus | undefined)[]): TrackerStatus | undefined =>
  statuses.reduce<TrackerStatus | undefined>(
    (best, status) => !status ? best : !best || !status.ts || (best.ts !== undefined && status.ts >= best.ts) ? status : best,
    undefined,
  );

const withStatus = (points: TrackPointInput[], status: TrackerStatus | undefined): TrackerFixes => status ? { points, status } : { points };

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
  const ts = trackerTime(params.get('timestamp'));
  const status = statusOf({ battery: percent(finite(params.get('batt') ?? params.get('battery'))), charging: flag(params.get('charge')), ts });
  const lat = finite(params.get('lat'));
  const lng = finite(params.get('lon') ?? params.get('lng'));
  if (lat === undefined && lng === undefined) return withStatus([], status);
  if (lat === undefined || lng === undefined || !onEarth(lat, lng)) return { error: 'lat and lon have to be a position' };

  const knots = finite(params.get('speed'));
  return withStatus([
    point(lat, lng, ts, {
      alt: finite(params.get('altitude')),
      speed: knots === undefined ? undefined : knots * KNOT_MS,
      course: finite(params.get('bearing') ?? params.get('heading')),
      accuracy: finite(params.get('accuracy')),
    }),
  ], status);
};

type TraccarLocation = {
  coords?: Record<string, unknown>;
  timestamp?: unknown;
  battery?: { level?: unknown; is_charging?: unknown };
  activity?: { type?: unknown };
};

/** What one Traccar Client location says of the device: its battery, a fraction, and its activity. */
const traccarStatus = (location: TraccarLocation, ts: string | undefined): TrackerStatus | undefined => {
  const level = finite(location.battery?.level);
  const activity = typeof location.activity?.type === 'string' && location.activity.type !== 'unknown' ? location.activity.type : undefined;
  return statusOf({ battery: percent(level === undefined ? undefined : level * 100), charging: flag(location.battery?.is_charging), activity, ts });
};

/** One Traccar Client location: a point, undefined for one without coordinates, or an error. */
const traccarLocation = (location: TraccarLocation, ts: string | undefined): TrackPointInput | undefined | { error: string } => {
  const coords = location.coords;
  if (!coords || typeof coords !== 'object') return undefined;
  const lat = finite(coords.latitude);
  const lng = finite(coords.longitude);
  if (lat === undefined || lng === undefined || !onEarth(lat, lng)) return { error: 'location.coords has no position' };

  const speed = finite(coords.speed);
  const heading = finite(coords.heading);
  return point(lat, lng, ts, {
    alt: finite(coords.altitude),
    speed: speed !== undefined && speed >= 0 ? speed : undefined,
    course: heading !== undefined && heading >= 0 ? heading : undefined,
    accuracy: finite(coords.accuracy),
  });
};

/** Traccar Client's JSON body: its location, or each of a list of them; none for a body without one. */
export const fromTraccarJson = (body: Record<string, unknown>): TrackerFixes => {
  const locations = (Array.isArray(body.location) ? body.location : [body.location ?? body]) as (TraccarLocation | undefined)[];
  const points: TrackPointInput[] = [];
  const statuses: (TrackerStatus | undefined)[] = [];
  for (const location of locations) {
    if (!location || typeof location !== 'object') continue;
    const ts = trackerTime(location.timestamp);
    const read = traccarLocation(location, ts);
    if (read && 'error' in read) return read;
    if (read) points.push(read);
    statuses.push(traccarStatus(location, ts));
  }
  return withStatus(points, newest(statuses));
};

/**
 * EiN's own points: a JSON object, a JSON list, or one object a line. A point's `battery`,
 * `charging` and `activity` are the device's status then, and the newest point's is kept.
 */
const fromNative = (text: string): TrackerFixes => {
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
  const points: TrackPointInput[] = [];
  const statuses: (TrackerStatus | undefined)[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      points.push(entry as TrackPointInput);
      continue;
    }
    const { battery, charging, activity, ...fix } = entry as Record<string, unknown>;
    points.push(fix as TrackPointInput);
    statuses.push(statusOf({
      battery: percent(finite(battery)),
      charging: flag(charging),
      activity: typeof activity === 'string' && activity && activity !== 'unknown' ? activity : undefined,
      ts: trackerTime(fix.ts),
    }));
  }
  return withStatus(points, newest(statuses));
};

/** Whether a parsed JSON body is Traccar Client's rather than EiN's own points. */
const isTraccarBody = (body: unknown): body is Record<string, unknown> =>
  typeof body === 'object' && body !== null && !Array.isArray(body) && ('location' in body || 'coords' in body || 'device_id' in body);

/** A GPX document's fixes that have a time, or why it has none. */
const fromGpx = (xml: string): TrackerFixes => {
  const timed = timedPoints(parseGpx(xml).points);
  return timed.problem ? { error: timed.problem } : { points: timed.points };
};

/**
 * Whatever protocol a request speaks, its points: a GPRMC sentence in `gprmc`, then a GPX
 * document, then a JSON body (Traccar Client's, or EiN's own), then OsmAnd's parameters from the
 * form body and the query.
 */
export const readTrackerRequest = (url: URL, contentType: string, body: string): TrackerFixes => {
  const form = contentType.includes('application/x-www-form-urlencoded') ? new URLSearchParams(body) : undefined;
  const gprmc = url.searchParams.get('gprmc') ?? form?.get('gprmc');
  if (gprmc) return fromGprmc(gprmc);
  if (isGpx(body, contentType)) return fromGpx(body);

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
