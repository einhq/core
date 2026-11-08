/**
 * GPX documents read into fixes: what a GPS logger or a phone app saves, and what core's `tracker`
 * driver takes as raw input for a device's track.
 */

import type { TrackPointInput } from '../../registries/track/types.ts';

const TRKPT_RE = /<trkpt\b([^>]*)(?:\/>|>([\s\S]*?)<\/trkpt>)/g;

/** What a GPX file says about itself and its fixes. */
export type Gpx = {
  /** The `creator` attribute: the program or camera that wrote the file. */
  creator?: string;
  /** The file's own `<name>`, `<desc>` and `<time>`: in `<metadata>` (GPX 1.1) or the root (GPX 1.0). */
  name?: string;
  description?: string;
  time?: string;
  /** Each `<trk>`'s `<name>`, in document order. */
  tracks: string[];
  /** Every `<name>` in it — the file's, its tracks' — in document order. */
  names: string[];
  points: TrackPointInput[];
};

/** Whether a document is GPX: an XML declaration or a `<gpx>` root, or the type says so. */
export const isGpx = (text: string, contentType = ''): boolean => contentType.includes('gpx') || /^\s*(<\?xml\b[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<gpx\b/.test(text);

/** `&amp;`, `&lt;`, `&gt;`, `&quot;` and `&apos;` as the characters they stand for. */
const unescapeXml = (text: string): string => text.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity]!);

/** The text of each `<tag>` in `xml`, CDATA or not, trimmed; empty ones left out. */
const texts = (xml: string, tag: string): string[] =>
  [...xml.matchAll(new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[)?([^<\\]]*?)(?:\\]\\]>)?\\s*</${tag}>`, 'g'))].map((m) => unescapeXml(m[1].trim())).filter(Boolean);

/** A number in the first `<tag>` (with or without a namespace prefix) of a point's body, if any. */
const pointNumber = (body: string, tag: string): number | undefined => {
  const text = body.match(new RegExp(`<(?:\\w+:)?${tag}>([^<]+)</(?:\\w+:)?${tag}>`))?.[1];
  const value = text === undefined ? NaN : Number(text);
  return Number.isFinite(value) ? value : undefined;
};

/**
 * Read a GPX document: its `<trkpt>` fixes (lat/lon in either order, optional `<ele>`, `<time>`,
 * and speed in m/s and course in degrees from GPX 1.0 or Garmin's TrackPointExtension), creator, own
 * name, description and time, and names.
 */
export function parseGpx(xml: string): Gpx {
  const points: TrackPointInput[] = [];

  for (const match of xml.matchAll(TRKPT_RE)) {
    const attrs = match[1];
    const lat = Number(attrs.match(/\blat="([^"]+)"/)?.[1]);
    const lng = Number(attrs.match(/\blon="([^"]+)"/)?.[1]);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const point: TrackPointInput = { lat, lng };
    const body = match[2] ?? '';

    const ele = body.match(/<ele>([^<]+)<\/ele>/);
    if (ele && Number.isFinite(Number(ele[1]))) point.alt = Number(ele[1]);

    const speed = pointNumber(body, 'speed');
    if (speed !== undefined) point.speed = speed;
    const course = pointNumber(body, 'course');
    if (course !== undefined) point.course = course;

    const time = body.match(/<time>([^<]+)<\/time>/);
    if (time) {
      const ts = new Date(time[1]);
      if (!Number.isNaN(ts.getTime())) point.ts = ts.toISOString();
    }

    points.push(point);
  }

  // Names inside a point (`<trkpt><name>`) are waypoint labels, not what wrote the file.
  const outside = xml.replace(TRKPT_RE, '');
  const creator = unescapeXml(xml.match(/<gpx\b[^>]*\bcreator="([^"]*)"/)?.[1]?.trim() ?? '') || undefined;
  const names = texts(outside, 'name');
  // What is left without tracks, routes and waypoints is the file's own: its metadata, or the root's children.
  const own = outside.replace(/<(trk|rte|wpt)\b[\s\S]*?<\/\1>/g, '');
  const tracks = [...outside.matchAll(/<trk\b[^>]*>([\s\S]*?)<\/trk>/g)].flatMap((m) => texts(m[1].replace(/<trkseg\b[\s\S]*?<\/trkseg>/g, ''), 'name').slice(0, 1));

  return { creator, name: texts(own, 'name')[0], description: texts(own, 'desc')[0], time: texts(own, 'time')[0], tracks, names, points };
}

/**
 * The fixes of a GPX file a track takes: those with a time. A track is keyed by time, and the
 * registry gives a point without one the moment it arrives, which for a file is the upload rather
 * than when the track was there; such points are left out. `problem` says why nothing is left.
 */
export function timedPoints(points: TrackPointInput[]): { points: TrackPointInput[]; untimed: number; problem?: string } {
  const timed = points.filter((point) => point.ts !== undefined);
  const problem = points.length === 0 ? 'no track points found' : timed.length === 0 ? `none of its ${points.length} track points has a time` : undefined;
  return { points: timed, untimed: points.length - timed.length, ...(problem ? { problem } : {}) };
}
