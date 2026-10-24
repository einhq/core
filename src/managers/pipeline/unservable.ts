import { join } from '@std/path';
import { createLogger } from '../logger/mod.ts';
import type { PoolWorkerState } from './pool-worker.ts';
import { TRIGGER_POOL } from './types.ts';

const logger = createLogger('pool-unservable');

/**
 * How long a kind must sit with ready jobs and no worker offering it before that is a fault.
 *
 * A worker that has not started yet is not one: services come up in order, so a kind is
 * routinely unoffered for a few seconds after boot, and a config change restarts the worker
 * that reads it. Both close well inside this. What it is meant to catch persists indefinitely
 * — a kind renamed under queued jobs, a worker service that crashed, a `--kind` dropped from
 * a start script, a typo in a definition — so a few minutes of delay costs nothing against the
 * false alarm on every deploy that a shorter window would raise.
 */
export const UNSERVABLE_GRACE_MS = 5 * 60_000;

/** A kind with claimable work that no live worker will ever claim. */
type UnservableKind = {
  pool: string;
  kind: string;
  ready: number;
  /** When the kind was first seen unoffered with ready jobs — not when the grace ran out. */
  since: number;
};

/** The per-kind counts the tracker needs, keyed by pool name as the metrics sampler keys them. */
type ReadyByKind = Record<string, { byKind?: Record<string, { ready: number }> }>;

/**
 * Finds pool kinds that will never drain because nothing offers them.
 *
 * The pool cannot see this on its own: it stores nothing about workers, so a job whose kind
 * no worker offers is simply `ready` and stays `ready` — no failed attempt, no lease to
 * expire, nothing has happened. Every other alarm is about work that ran and misbehaved. This
 * is the one about work that will never run, and it needs both halves joined: the pool's
 * per-kind backlog and the live workers' offers.
 *
 * Distinct from a kind whose worker is currently on another kind. That one is waiting and the
 * wait ends; this one does not. A worker with no `kinds` at all offers everything its capacity
 * allows, so it serves every kind in its pool.
 *
 * Process-local state, like the worker registry it reads: the grace needs to know when a kind
 * was first seen unoffered, and it starts empty at boot, which is exactly what makes boot order
 * safe — nothing can be older than the process.
 */
export class UnservableTracker {
  /** First observation of each unoffered kind with ready jobs, keyed by `pool\0kind`. */
  private readonly firstSeen = new Map<string, { pool: string; kind: string; ready: number; since: number }>();
  /** Keys whose alarm has been raised, so the log says it once and says when it clears. */
  private readonly raised = new Set<string>();

  constructor(private readonly graceMs = UNSERVABLE_GRACE_MS) {}

  /**
   * Re-evaluate from a fresh reading. Returns the kinds past their grace.
   *
   * `poolsPath` is the directory the pool names in `pools` live under; workers name their pool
   * by full path. The intake pool is skipped: the engine claims it, not a worker.
   */
  observe(poolsPath: string, pools: ReadyByKind, workers: PoolWorkerState[], now = Date.now()): UnservableKind[] {
    const seen = new Set<string>();

    for (const [name, counts] of Object.entries(pools)) {
      if (name === TRIGGER_POOL) continue;
      const poolPath = join(poolsPath, name);
      const offers = workers.filter((worker) => worker.pool === poolPath);

      for (const [kind, { ready }] of Object.entries(counts.byKind ?? {})) {
        if (ready <= 0) continue;
        if (offers.some((worker) => worker.kinds.length === 0 || worker.kinds.includes(kind))) continue;

        const key = `${name}\0${kind}`;
        seen.add(key);
        const entry = this.firstSeen.get(key);
        if (entry) entry.ready = ready;
        else this.firstSeen.set(key, { pool: name, kind, ready, since: now });
      }
    }

    for (const [key, entry] of this.firstSeen) {
      if (seen.has(key)) continue;
      this.firstSeen.delete(key);
      if (this.raised.delete(key)) {
        logger.info('pool kind is servable again', { pool: entry.pool, kind: entry.kind });
      }
    }

    return this.current(now);
  }

  /** The kinds past their grace as of the last `observe`. */
  unservable(now = Date.now()): UnservableKind[] {
    return this.current(now);
  }

  private current(now: number): UnservableKind[] {
    const out: UnservableKind[] = [];
    for (const [key, entry] of this.firstSeen) {
      if (now - entry.since < this.graceMs) continue;
      if (!this.raised.has(key)) {
        this.raised.add(key);
        // The one line that reaches someone who is not looking at the dashboard.
        logger.warn('pool kind has ready jobs but no live worker offers it', {
          pool: entry.pool,
          kind: entry.kind,
          ready: entry.ready,
          unofferedForMs: now - entry.since,
        });
      }
      out.push({ ...entry });
    }
    return out;
  }
}

/** The process's tracker: fed by `metrics-sampler`, read by `pool-stat`. */
export const unservableKinds = new UnservableTracker();
