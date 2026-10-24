import { RegistryIf, ResourceOptions } from '../types.ts';

/** Track options. These are the node attrs: the VFS hands a registry the node's attrs as options. */
export type TrackResourceOptions = ResourceOptions & {
  /**
   * Routing keys the track binds to. A relay event carrying a point (or an
   * array of them) is appended, which is how a tracker device feeds a track
   * live without knowing anything about the VFS.
   */
  routingKeys?: string[];
};

/** One recorded fix. `ts` is the primary key, so it is never optional at rest. */
export type TrackPoint = {
  lat: number;
  lng: number;
  /** ISO timestamp of the fix. */
  ts: string;
  alt?: number;
  speed?: number;
  course?: number;
};

/** A point on the way in, where the caller may not have a timestamp yet. */
export type TrackPointInput = Omit<TrackPoint, 'ts'> & { ts?: string };

/** Geographic bounding box. Same shape as the position registry's GeoBounds. */
export type TrackBounds = {
  north: number;
  south: number;
  east: number;
  west: number;
};

/**
 * What a track is, without reading it. Maintained by the registry on every
 * append and delete, in the same transaction, so it cannot drift from the
 * points.
 */
export type TrackSummary = {
  points: number;
  firstTs?: string;
  lastTs?: string;
  bbox?: TrackBounds;
};

export type TrackStat = TrackSummary & {
  /** Point count, so `stat().size` means the same thing it does elsewhere. */
  size: number;
  routingKeys: string[];
};

/** Half-open time range `[from, to)`, either end optional. */
export type TrackRange = {
  from?: string;
  to?: string;
};

export type TrackReadOptions = TrackRange & {
  /** Only points inside this box (widened by `margin`). */
  bounds?: TrackBounds;
  /**
   * How far outside `bounds` to read, as a fraction of the box's own size.
   *
   * Lines have to reach the edge of the viewport rather than stop short of it,
   * which means keeping the points just outside it. Doing that exactly — keep a
   * point whose neighbour is inside — needs a window function over the track's
   * whole ordered sequence, which cannot use the spatial index and so scans
   * the whole track. Widening the query box keeps the index scan and costs a
   * little extra geometry.
   */
  margin?: number;
  /**
   * Douglas–Peucker tolerance in degrees. Set from zoom by the caller: roughly
   * the size of one screen pixel, so the line loses only what cannot be seen.
   * Omitted means every point, and `alt`/`speed`/`course` survive — a simplified
   * read keeps position and time only.
   */
  tolerance?: number;
  /** Cap on returned vertices. */
  limit?: number;
  /** Override the gap rule (ms). Default is derived from the points themselves. */
  gapMs?: number;
};

/** A drawable run of points: one day, no holes. */
export type TrackSegment = {
  /** UTC date, `YYYY-MM-DD`. What a color is keyed on. */
  day: string;
  points: TrackPoint[];
};

export type TrackReadResult = {
  segments: TrackSegment[];
  /** Vertices actually returned, across all segments. */
  points: number;
  /** The read hit `limit` and was thinned or cut. */
  truncated: boolean;
};

/** Low-level operations behind a {@link TrackHandle}. */
export interface TrackIO {
  /** Insert points, ignoring ones whose timestamp is already present. Returns rows written. */
  append(points: TrackPoint[]): Promise<number>;
  /** Ordered points after `afterTs`, for the byte-stream/follow view. Blocks when a signal is given and nothing is there. */
  page(afterTs: string | undefined, limit: number, signal?: AbortSignal): Promise<TrackPoint[]>;
  /** The viewport read: filter, simplify, split into segments. */
  read(opts: TrackReadOptions): Promise<TrackReadResult>;
  /** Drop a time range. Returns rows removed. */
  remove(range: TrackRange): Promise<number>;
  summary(): Promise<TrackSummary>;
}

/**
 * Registry of tracks: ordered series of geographic fixes, indexed spatially
 * and by time, so every question a map asks — what is in this box, what
 * happened that week, what does this look like from far away — is an index
 * read.
 */
export interface TrackRegistryIf extends RegistryIf<TrackResourceOptions, TrackStat> {
  /** Append points to a track, upserting on timestamp. Returns rows written. */
  appendPoints(id: string, points: TrackPoint[]): Promise<number>;
  /** Read a track as drawable segments. */
  readPoints(id: string, opts?: TrackReadOptions): Promise<TrackReadResult>;
  /** Ordered raw points after `afterTs`. */
  pagePoints(id: string, afterTs: string | undefined, limit: number, signal?: AbortSignal): Promise<TrackPoint[]>;
  /** Delete a time range from a track. Returns rows removed. */
  deletePoints(id: string, range: TrackRange): Promise<number>;
  /** Point count, time span and extent, without reading the points. */
  summary(id: string): Promise<TrackSummary>;
  /** The summary of each of many tracks, in one read. Ids with no track are absent. */
  summaries(ids: string[]): Promise<Map<string, TrackSummary>>;
}
