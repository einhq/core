/**
 * MemoryTrackRegistry — tracks held in process, with the PostGIS predicates
 * (bbox filter, Douglas–Peucker simplification) reimplemented in TypeScript.
 * Mirrors {@link TrackRegistry} semantics; this is what the fast test tier and
 * every memory-mounted instance run against. Its tracks are small, so every
 * append, delete and mark judges the whole track again (`rules.ts`).
 */
import type { RelayEventUnsubscriber, RouterManagerIf } from '../../managers/router/mod.ts';
import { routingKeysMatch } from '../routing-key-match.ts';
import { ensureResource, ResourceMode } from '../types.ts';
import { judgeFixes, TrackRule } from './rules.ts';
import { capSegments, dropLoneSpikes, expandBounds, inBounds, splitRuns, toSegments } from './segment.ts';
import { TrackHandle } from './track-handle.ts';
import {
  TrackIO,
  TrackPoint,
  TrackPointInput,
  TrackRange,
  TrackReadOptions,
  TrackReadResult,
  TrackRegistryIf,
  TrackResourceOptions,
  TrackStat,
  TrackSummary,
  TrackVerdict,
} from './types.ts';
import { countPoints, DEFAULT_MARGIN, normalizePoints, normalizeTime, stripSegments, summarize, vertexOf } from './lib.ts';

type MemoryTrackRegistryConfig = {
  router: RouterManagerIf;
};

type TrackMeta = {
  routingKeys: string[];
  createdAt: Date;
};

export class MemoryTrackRegistry implements TrackRegistryIf {
  private initialized = false;
  private tracks = new Map<string, TrackMeta>();
  private points = new Map<string, TrackPoint[]>();
  /** Each track's judged fixes by timestamp; a fix not in it is accepted. */
  private rules = new Map<string, Map<string, TrackRule>>();
  /** Each track's fixes a person gave a verdict on, by timestamp. */
  private manual = new Map<string, Map<string, TrackVerdict>>();
  private waiters = new Map<string, Set<() => void>>();
  private relayUnsubscribe: RelayEventUnsubscriber | undefined;

  constructor(private config: MemoryTrackRegistryConfig) {}

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.relayUnsubscribe = this.config.router.on(async (routingKey: string, payload: unknown) => {
      await this.handleRelayEvent(routingKey, payload);
    });

    this.initialized = true;
  }

  async dispose(): Promise<void> {
    if (this.relayUnsubscribe) {
      this.relayUnsubscribe();
      this.relayUnsubscribe = undefined;
    }

    for (const set of this.waiters.values()) {
      for (const cb of set) cb();
    }

    this.tracks.clear();
    this.points.clear();
    this.rules.clear();
    this.manual.clear();
    this.waiters.clear();
  }

  async touch(id: string, opts: TrackResourceOptions): Promise<boolean> {
    const routingKeys = opts.routingKeys ?? [];
    const existing = this.tracks.get(id);

    if (existing) {
      if (arraysEqual(existing.routingKeys, routingKeys)) {
        return false;
      }

      existing.routingKeys = routingKeys;
      return true;
    }

    this.tracks.set(id, { routingKeys, createdAt: new Date() });
    this.points.set(id, []);
    this.rules.set(id, new Map());
    this.manual.set(id, new Map());
    return true;
  }

  async open(id: string, opts: TrackResourceOptions, mode?: ResourceMode): Promise<TrackHandle> {
    const { truncate } = await ensureResource(this, id, opts, mode);

    if (truncate) {
      this.points.set(id, []);
      this.rules.set(id, new Map());
      this.manual.set(id, new Map());
    }

    const io: TrackIO = {
      append: (points: TrackPointInput[]) => this.appendPoints(id, points),
      page: (afterTs, limit, signal) => this.pagePoints(id, afterTs, limit, signal),
      read: (readOpts) => this.readPoints(id, readOpts),
      remove: (range) => this.deletePoints(id, range),
      mark: (range, verdict) => this.markPoints(id, range, verdict),
      summary: () => this.summary(id),
    };

    const rh = new TrackHandle(id, opts, mode || 'r', this, io);
    await rh.init();

    return rh;
  }

  async exists(id: string): Promise<boolean> {
    return this.tracks.has(id);
  }

  async stat(id: string): Promise<TrackStat> {
    const meta = this.tracks.get(id);

    if (!meta) {
      throw new Error(`no track found: ${id}`);
    }

    const summary = summarize(this.accepted(id));

    return { ...summary, size: summary.points, routingKeys: meta.routingKeys };
  }

  async statX(id: string): Promise<TrackStat> {
    return this.stat(id);
  }

  async delete(id: string): Promise<boolean> {
    if (!this.tracks.has(id)) {
      return false;
    }

    this.tracks.delete(id);
    this.points.delete(id);
    this.rules.delete(id);
    this.manual.delete(id);
    this.notifyWaiters(id);
    this.waiters.delete(id);

    return true;
  }

  async list(): Promise<AsyncIterable<string>> {
    const ids = [...this.tracks.keys()];

    return (async function* () {
      for (const id of ids) {
        yield id;
      }
    })();
  }

  async count(_id?: string): Promise<number> {
    return this.tracks.size;
  }

  /** Insert points in timestamp order, ignoring timestamps already present, and judge the track. */
  async appendPoints(id: string, points: TrackPointInput[]): Promise<number> {
    const stored = this.pointsOf(id);
    const incoming = normalizePoints(points);

    if (incoming.length === 0) return 0;

    const seen = new Set(stored.map((point) => point.ts));
    let written = 0;

    for (const point of incoming) {
      if (seen.has(point.ts)) continue;
      seen.add(point.ts);
      stored.push(point);
      written++;
    }

    // Sorted at rest, so a backdated import reads back in time order.
    stored.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

    if (written > 0) {
      this.judge(id);
      this.notifyWaiters(id);
    }

    return written;
  }

  async readPoints(id: string, opts: TrackReadOptions = {}): Promise<TrackReadResult> {
    const stored = this.pointsOf(id);
    const bounds = opts.bounds ? expandBounds(opts.bounds, opts.margin ?? DEFAULT_MARGIN) : undefined;
    const from = normalizeTime(opts.from, 'from');
    const to = normalizeTime(opts.to, 'to');

    const rules = this.rulesOf(id);
    const manual = this.manualOf(id);

    const filtered = stored.filter((point) => {
      if (from !== undefined && point.ts < from) return false;
      if (to !== undefined && point.ts >= to) return false;
      if (bounds && !inBounds(bounds, point)) return false;
      return true;
    });

    // Runs no line joins: a jump starts one; read alone, the rejected fixes start one after each accepted fix.
    const runOf = new Map<TrackPoint, number>();
    let runs = 0;
    for (const point of filtered) {
      const rejected = leftOut(rules, manual, point.ts);
      if (opts.rejected === 'only' ? !rejected : rules.get(point.ts) === 'jump') runs++;
      if (opts.rejected === 'only' ? rejected : opts.rejected || !rejected) runOf.set(point, runs);
    }

    const tolerance = opts.tolerance ?? 0;
    const full = splitRuns([...runOf.keys()], (point, previous) => runOf.get(point) !== runOf.get(previous)).flatMap((run) => {
      const marked = run.map((point) => this.marked(id, point));
      const despiked = opts.still ? dropLoneSpikes(marked, opts.still.maxSpeed) : marked;
      if (tolerance <= 0) return toSegments(despiked, tolerance, opts.still);
      // A simplified read keeps position and time only, as the PostGIS path does:
      // there it is a vertex of a LINESTRINGM and the rest never comes back.
      return stripSegments(toSegments(despiked.map(vertexOf), tolerance, opts.still));
    });
    const fullCount = countPoints(full);

    const segments = opts.limit === undefined ? full : capSegments(full, opts.limit);
    const count = countPoints(segments);

    return { segments, points: count, truncated: count < fullCount };
  }

  async pagePoints(id: string, afterTs: string | undefined, limit: number, signal?: AbortSignal): Promise<TrackPoint[]> {
    const stored = this.pointsOf(id);
    const after = normalizeTime(afterTs, 'afterTs');
    const page = () => stored.filter((point) => after === undefined || point.ts > after).slice(0, limit).map((point) => this.marked(id, point));

    const first = page();
    if (first.length > 0 || !signal) return first;

    return await new Promise<TrackPoint[]>((resolve) => {
      const tryRead = () => {
        const next = page();
        if (next.length === 0) return;
        cleanup();
        resolve(next);
      };

      const onAbort = () => {
        cleanup();
        resolve([]);
      };

      const removeWaiter = this.addWaiter(id, tryRead);

      const cleanup = () => {
        removeWaiter();
        signal.removeEventListener('abort', onAbort);
      };

      signal.addEventListener('abort', onAbort, { once: true });

      if (signal.aborted) onAbort();
    });
  }

  async deletePoints(id: string, range: TrackRange): Promise<number> {
    const stored = this.pointsOf(id);
    const from = normalizeTime(range.from, 'from');
    const to = normalizeTime(range.to, 'to');

    const kept = stored.filter((point) => {
      const after = from === undefined || point.ts >= from;
      const before = to === undefined || point.ts < to;
      return !(after && before);
    });

    const removed = stored.length - kept.length;
    this.points.set(id, kept);
    if (removed > 0) {
      const manual = this.manualOf(id);
      const left = new Set(kept.map((point) => point.ts));
      for (const ts of manual.keys()) if (!left.has(ts)) manual.delete(ts);
      this.judge(id);
    }

    return removed;
  }

  async markPoints(id: string, range: TrackRange, verdict: TrackVerdict | null): Promise<number> {
    const stored = this.pointsOf(id);
    const manual = this.manualOf(id);
    const from = normalizeTime(range.from, 'from');
    const to = normalizeTime(range.to, 'to');
    let changed = 0;

    for (const { ts } of stored) {
      if ((from !== undefined && ts < from) || (to !== undefined && ts >= to) || (manual.get(ts) ?? null) === verdict) continue;
      if (verdict) manual.set(ts, verdict);
      else manual.delete(ts);
      changed++;
    }

    if (changed > 0) this.judge(id);

    return changed;
  }

  async summary(id: string): Promise<TrackSummary> {
    return summarize(this.accepted(id));
  }

  async summaries(ids: string[]): Promise<Map<string, TrackSummary>> {
    const found = new Map<string, TrackSummary>();
    for (const id of ids) {
      if (this.points.has(id)) found.set(id, summarize(this.accepted(id)));
    }
    return found;
  }

  private pointsOf(id: string): TrackPoint[] {
    const stored = this.points.get(id);
    if (!stored) throw new Error(`no track found: ${id}`);
    return stored;
  }

  private rulesOf(id: string): Map<string, TrackRule> {
    let rules = this.rules.get(id);
    if (!rules) this.rules.set(id, rules = new Map());
    return rules;
  }

  private manualOf(id: string): Map<string, TrackVerdict> {
    let manual = this.manual.get(id);
    if (!manual) this.manual.set(id, manual = new Map());
    return manual;
  }

  /** The fixes neither a rule nor a person rejected. */
  private accepted(id: string): TrackPoint[] {
    const rules = this.rulesOf(id);
    const manual = this.manualOf(id);
    return this.pointsOf(id).filter((point) => !leftOut(rules, manual, point.ts));
  }

  /** A fix as a read that keeps detail shows it: why it is left out, and what a person said of it. */
  private marked(id: string, point: TrackPoint): TrackPoint {
    const manual = this.manualOf(id).get(point.ts);
    const rejected = manual === 'reject' ? 'manual' : !manual && this.rulesOf(id).get(point.ts) === 'excursion' ? 'excursion' : undefined;
    return manual || rejected ? { ...point, ...(rejected && { rejected }), ...(manual && { manual }) } : point;
  }

  /** Judge every fix of a track again, but those a person rejected: the rules judge the track without them. */
  private judge(id: string): void {
    const manual = this.manualOf(id);
    const judged = this.pointsOf(id).filter((point) => manual.get(point.ts) !== 'reject');
    const verdicts = judgeFixes(judged.map((point) => ({ ms: Date.parse(point.ts), lat: point.lat, lng: point.lng })));
    const rules = new Map<string, TrackRule>();
    verdicts.forEach((rule, i) => rule && rules.set(judged[i].ts, rule));
    this.rules.set(id, rules);
  }

  private async handleRelayEvent(routingKey: string, payload: unknown): Promise<void> {
    const points = normalizePoints(Array.isArray(payload) ? payload as TrackPoint[] : [payload as TrackPoint]);
    if (points.length === 0) return;

    for (const [id, meta] of this.tracks) {
      if (routingKeysMatch(meta.routingKeys, routingKey)) {
        await this.appendPoints(id, points);
      }
    }
  }

  private addWaiter(id: string, callback: () => void): () => void {
    let set = this.waiters.get(id);
    if (!set) {
      set = new Set();
      this.waiters.set(id, set);
    }
    set.add(callback);
    return () => {
      set!.delete(callback);
      if (set!.size === 0) this.waiters.delete(id);
    };
  }

  private notifyWaiters(id: string): void {
    const set = this.waiters.get(id);
    if (set) {
      for (const cb of set) cb();
    }
  }
}

/** Whether a fix is left out: a person rejected it, or a rule did and no person accepted it. */
function leftOut(rules: Map<string, TrackRule>, manual: Map<string, TrackVerdict>, ts: string): boolean {
  const verdict = manual.get(ts);
  return verdict ? verdict === 'reject' : rules.get(ts) === 'excursion';
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
