/**
 * MemoryTrackRegistry — tracks held in process, with the PostGIS predicates
 * (bbox filter, Douglas–Peucker simplification) reimplemented in TypeScript.
 * Mirrors {@link TrackRegistry} semantics; this is what the fast test tier and
 * every memory-mounted instance run against. Its tracks are small, so every
 * append and delete judges the whole track again (`rules.ts`).
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
} from './types.ts';
import { countPoints, DEFAULT_MARGIN, normalizePoints, normalizeTime, stripDetail, summarize } from './lib.ts';

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
    return true;
  }

  async open(id: string, opts: TrackResourceOptions, mode?: ResourceMode): Promise<TrackHandle> {
    const { truncate } = await ensureResource(this, id, opts, mode);

    if (truncate) {
      this.points.set(id, []);
      this.rules.set(id, new Map());
    }

    const io: TrackIO = {
      append: (points: TrackPointInput[]) => this.appendPoints(id, points),
      page: (afterTs, limit, signal) => this.pagePoints(id, afterTs, limit, signal),
      read: (readOpts) => this.readPoints(id, readOpts),
      remove: (range) => this.deletePoints(id, range),
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

    const filtered = stored.filter((point) => {
      if (from !== undefined && point.ts < from) return false;
      if (to !== undefined && point.ts >= to) return false;
      if (bounds && !inBounds(bounds, point)) return false;
      if (!opts.rejected && rules.get(point.ts) === 'excursion') return false;
      return true;
    });

    const tolerance = opts.tolerance ?? 0;
    const full = splitRuns(filtered, (point) => rules.get(point.ts) === 'jump').flatMap((run) => {
      // A simplified read keeps position and time only, as the PostGIS path does:
      // there it is a vertex of a LINESTRINGM and the rest never comes back.
      const despiked = opts.still ? dropLoneSpikes(run, opts.still.maxSpeed) : run;
      return toSegments(tolerance > 0 ? despiked.map(stripDetail) : despiked.map((point) => this.marked(rules, point)), tolerance, opts.still);
    });
    const fullCount = countPoints(full);

    const segments = opts.limit === undefined ? full : capSegments(full, opts.limit);
    const count = countPoints(segments);

    return { segments, points: count, truncated: count < fullCount };
  }

  async pagePoints(id: string, afterTs: string | undefined, limit: number, signal?: AbortSignal): Promise<TrackPoint[]> {
    const stored = this.pointsOf(id);
    const after = normalizeTime(afterTs, 'afterTs');
    const page = () => stored.filter((point) => after === undefined || point.ts > after).slice(0, limit).map((point) => this.marked(this.rulesOf(id), point));

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
    if (removed > 0) this.judge(id);

    return removed;
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

  /** The fixes no rule rejected. */
  private accepted(id: string): TrackPoint[] {
    const rules = this.rulesOf(id);
    return this.pointsOf(id).filter((point) => rules.get(point.ts) !== 'excursion');
  }

  /** A rejected fix as a read with its rejected ones shows it; any other as it is. */
  private marked(rules: Map<string, TrackRule>, point: TrackPoint): TrackPoint {
    return rules.get(point.ts) === 'excursion' ? { ...point, rejected: 'excursion' } : point;
  }

  /** Judge every fix of a track again. */
  private judge(id: string): void {
    const stored = this.pointsOf(id);
    const verdicts = judgeFixes(stored.map((point) => ({ ms: Date.parse(point.ts), lat: point.lat, lng: point.lng })));
    const rules = new Map<string, TrackRule>();
    verdicts.forEach((rule, i) => rule && rules.set(stored[i].ts, rule));
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

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
