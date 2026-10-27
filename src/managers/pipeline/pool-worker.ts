import { basename, dirname, join } from '@std/path';
import { ADMIN_ACCESS, type Attribution } from '../../lib/access/mod.ts';
import { createLogger } from '../logger/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../vfs/types/directory.ts';
import { NODE_TYPE_POOL } from '../../vfs/types/pool.ts';
import type { NodeVFS } from '../../vfs/node-vfs.ts';
import type { PoolJob } from '../../registries/pool/mod.ts';
import type { TtyIf } from '../exec/types.ts';
import type { EventSubscription } from '../../vfs/types.ts';
import { STEP_EXIT_INPUT, STEP_EXIT_TEMPORARY } from '../../lib/step-exit.ts';
import { stepErrorDetail, stepErrorLogDetail } from './step-error.ts';
import { markOutput, runStep } from './step-run.ts';
import { isLiveInstance, type PipelineInstanceAttrs, type PipelineStepAttrs, type PoolJobParams } from './types.ts';

const logger = createLogger('pool-worker');

/** Fraction of the lease between heartbeats. Three ticks per lease. */
const HEARTBEAT_DIVISOR = 3;

/** Tries at handing a finished job back before leaving it to the pool sweep. */
const RELEASE_ATTEMPTS = 3;

/** Linear backoff between those tries. Well inside a 60 s lease. */
const RELEASE_RETRY_MS = 250;

/**
 * How long a kind rests after a step of it could not run yet (`STEP_EXIT_TEMPORARY`): the first
 * pause, doubled on each one after it up to the most. A down service is then asked once per
 * pause per kind instead of having the kind's whole backlog run into it, and a service that comes
 * back is noticed within the pause.
 */
const TEMPORARY_PAUSE_MS = 30_000;
const TEMPORARY_PAUSE_MAX_MS = 600_000;

/**
 * The longest a batching worker keeps its free slots idle for the kind it is leaving (see
 * `claimBatched`). The boundary keeps two large model families from being started together as a
 * batch turns over, which costs the minutes a step takes to finish; one long step of the old kind
 * held all four slots of fry's models worker for over an hour (ein/core#511).
 */
const KIND_BOUNDARY_MAX_MS = 5 * 60_000;

/**
 * The rotation's turns: each group of `kinds` once, at the place of its first kind, and every
 * kind in no group alone. Kinds a group names that the worker does not offer are left out of it.
 */
function turnsOf(kinds: string[], groups: string[][]): { name: string; kinds: string[] }[] {
  const turns: { name: string; kinds: string[] }[] = [];
  const placed = new Set<string>();
  for (const kind of kinds) {
    if (placed.has(kind)) continue;
    const group = groups.find((g) => g.includes(kind))?.filter((k) => kinds.includes(k) && !placed.has(k)) ?? [kind];
    for (const k of group) placed.add(k);
    turns.push({ name: group.join('+'), kinds: group });
  }
  return turns;
}

type PoolWorkerOptions = {
  poolPath: string;
  /** Total capacity this worker offers, e.g. `{ vramMb: 15000 }`. */
  capacity?: Record<string, number>;
  /** Only claim these kinds. Empty means anything the capacity allows. */
  kinds?: string[];
  /**
   * Prefer these kinds once remaining capacity reaches reserveCapacity.
   * The reservation is soft: when none can run, normal priority work uses
   * the capacity instead of leaving it idle.
   */
  reserveKinds?: string[];
  reserveCapacity?: Record<string, number>;
  concurrency?: number;
  /**
   * Batch jobs by kind: claim one kind until it drains or this many ms elapse, then rotate to
   * another kind that has work. 0 (the default) means every claim considers all kinds and the
   * pool's priority decides.
   *
   * This is an anti-starvation bound, not model affinity: rotating kinds evicts no model. When a
   * high-priority kind arrives continuously, "always take the highest priority" would never run
   * a lower one. Priority orders jobs *within* a kind; the quantum decides between kinds.
   */
  kindQuantumMs?: number;
  /**
   * Kinds that share a turn of the rotation (`kindQuantumMs`): within it they take slots in
   * turn, and a kind in no group has its turns alone. For backlogs whose models fit on the
   * card together, so one turn feeds them at once instead of each in its own quarter-hour —
   * the media service runs each family under its own lock, so different families infer side by
   * side. A turn is named by its kinds joined with `+` (`currentKind`).
   */
  kindGroups?: string[][];
  leaseMs?: number;
  bashrcPath?: string;
};

/**
 * What a live worker is doing, for anyone asking why a kind is not being drained.
 *
 * `currentKind` is the load-bearing field. A worker holds one kind until it drains or its
 * quantum expires, so a pool with ready jobs and nothing running is not stalled — it is on a
 * different kind, and that is invisible from the pool alone because the pool stores nothing
 * about workers.
 */
export type PoolWorkerState = {
  pool: string;
  owner: string;
  kinds: string[];
  /** The kind holding the worker right now, or undefined before its first claim. */
  currentKind?: string;
  /** When it took that kind, so a reader can say how much of the quantum is left. */
  kindSince?: number;
  /** 0 when the worker has one kind and rotation cannot arise. */
  kindQuantumMs: number;
  concurrency: number;
  reserveKinds: string[];
  reserveCapacity: Record<string, number>;
  nextReserveKind?: string;
  /** Kind the worker is holding free capacity for, so a "full pool, nothing admitted" reading has its reason. */
  accumulatingFor?: string;
  /** Kinds resting after a step could not run, by kind: when each will be tried again (epoch ms). */
  resting: Record<string, KindRest>;
};

/** Until when a kind is resting (`PoolWorkerState.resting`). */
type KindRest = { until: number };

/**
 * Live workers in this process, keyed by owner.
 *
 * A module-level registry rather than pool state on purpose: workers are deliberately anonymous
 * to the pool, and this is process-local diagnostics, not scheduling input. Commands run
 * in-process, so a status command reads it directly.
 */
const liveWorkers = new Map<string, PoolWorker>();

/** What every worker in this process is currently doing. */
export const poolWorkerStates = (): PoolWorkerState[] => [...liveWorkers.values()].map((w) => w.state());

/** Which rests `endRests` ends: only these kinds, or every one. */
type RestSelector = { kinds?: string[] };

/**
 * End the rests `sel` names in every worker in this process, so their kinds are claimed again at
 * once, and say which kinds of which pools that was.
 */
export const endRests = (sel: RestSelector = {}): { pool: string; kind: string }[] =>
  [...liveWorkers.values()].flatMap((w) => w.endRests(sel).map((kind) => ({ pool: w.state().pool, kind })));

/**
 * Runs delegated pipeline steps claimed from a work pool.
 *
 * The worker states what it *has* and the pool picks the best job that actually
 * fits. Scheduling policy therefore lives on the jobs and the pool node, not in
 * this worker's arguments, and no service restart is needed to retune a
 * priority.
 *
 * Capacity is tracked here rather than in the pool, which keeps the pool free of
 * worker state. There is one claim loop, not one per slot: `remaining` is shared,
 * and two loops racing to compute it would over-commit the card.
 *
 * Correctness rests on the step node: each claimed job is re-validated (instance
 * live, step still waiting, target present) before it runs, so a cancelled or
 * superseded job is simply dropped.
 * What the pool adds is a lease: a worker that dies stops renewing, and the
 * pool's sweep returns the job instead of the step sitting `running` until the
 * engine next restarts.
 */
export class PoolWorker {
  private running = false;
  private abort = new AbortController();
  /** Claimed jobs: the abort hangs up the step's command, `done` settles when `run` is over. */
  private inFlight = new Map<number, { job: PoolJob; abort: AbortController; done: Promise<void> }>();
  /** Capacity not currently committed to a claimed job. */
  private remaining: Record<string, number>;
  private readonly owner: string;
  private readonly poolPath: string;
  private readonly capacity: Record<string, number>;
  private readonly kinds: string[];
  private readonly reserveKinds: string[];
  private readonly reserveCapacity: Record<string, number>;
  private reserveCursor = 0;
  /** Where the next unreserved claim among the reserved kinds starts — see `claimWithReservation`. */
  private shareCursor = 0;
  /** Reserved kind whose next job is waiting for free capacity to add up — see `claimAccumulated`. */
  private accumulatingFor: string | undefined;
  private readonly concurrency: number;
  private readonly kindQuantumMs: number;
  /** The turns of the rotation, in order: a group's kinds, or one kind alone (`kindGroups`). */
  private readonly turns: { name: string; kinds: string[] }[];
  /** Where the next claim within each turn starts, by turn name. */
  private turnCursor = new Map<string, number>();
  /** Turn currently being drained (its name), and when this batch started. */
  private currentKind: string | undefined;
  private kindSince = 0;
  /** Kinds resting after a step said its service could not do it yet — see `TEMPORARY_PAUSE_MS`. */
  private paused = new Map<string, { until: number; ms: number }>();
  /** Aborted by `endRests` to end a park that is waiting for a rest to run out. */
  private restsEnded = new AbortController();
  /** Since when free slots have been held at a kind boundary, or undefined when they are not. */
  private boundarySince: number | undefined;
  private readonly leaseMs: number;
  private readonly bashrcPath: string;
  private bashrcSubscription: EventSubscription | undefined;

  constructor(private vfs: NodeVFS, private tty: TtyIf, opts: PoolWorkerOptions) {
    this.poolPath = opts.poolPath;
    this.capacity = { ...(opts.capacity ?? {}) };
    this.remaining = { ...this.capacity };
    this.kinds = opts.kinds ?? [];
    this.reserveKinds = opts.reserveKinds ?? [];
    this.reserveCapacity = { ...(opts.reserveCapacity ?? {}) };
    this.concurrency = Math.max(1, opts.concurrency ?? 1);
    this.turns = turnsOf(this.kinds, opts.kindGroups ?? []);
    // Batching needs at least two turns to rotate between; with one it is a no-op either way.
    this.kindQuantumMs = this.turns.length > 1 ? Math.max(0, opts.kindQuantumMs ?? 0) : 0;
    this.leaseMs = opts.leaseMs ?? 60_000;
    this.bashrcPath = opts.bashrcPath ?? '/etc/bashrc';
    this.owner = `${Deno.hostname()}:${Deno.pid}:${crypto.randomUUID().slice(0, 8)}`;
  }

  async start(): Promise<void> {
    this.running = true;
    this.abort = new AbortController();
    logger.info('pool worker starting', {
      pool: this.poolPath,
      capacity: this.capacity,
      kinds: this.kinds,
      turns: this.turns.map((turn) => turn.name),
      concurrency: this.concurrency,
      kindQuantumMs: this.kindQuantumMs,
      reserveKinds: this.reserveKinds,
      reserveCapacity: this.reserveCapacity,
    });

    // Subscribe before the initial read so a module setup racing worker startup cannot land
    // between the read and the watch. Step commands live in module bin dirs added here.
    await this.watchBashrc();
    await this.sourceBashrc(true);

    // Ensure the pool exists even if the worker starts before the engine.
    const poolDir = dirname(this.poolPath);
    await this.vfs.ensure(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, dirname(poolDir), basename(poolDir));
    await this.vfs.ensure(ADMIN_ACCESS, NODE_TYPE_POOL, dirname(this.poolPath), basename(this.poolPath));

    this.claimLoop().catch((err) => logger.error('claim loop error', { error: err }));

    liveWorkers.set(this.owner, this);
    logger.info('pool worker started', { pool: this.poolPath, owner: this.owner });
  }

  /** This worker's externally visible state — see `PoolWorkerState`. */
  state(): PoolWorkerState {
    return {
      pool: this.poolPath,
      owner: this.owner,
      kinds: [...this.kinds],
      currentKind: this.currentKind,
      kindSince: this.currentKind === undefined ? undefined : this.kindSince,
      kindQuantumMs: this.kindQuantumMs,
      concurrency: this.concurrency,
      reserveKinds: [...this.reserveKinds],
      reserveCapacity: { ...this.reserveCapacity },
      nextReserveKind: this.reserveKinds[this.reserveCursor],
      accumulatingFor: this.accumulatingFor,
      resting: Object.fromEntries(
        [...this.paused].filter(([, p]) => p.until > Date.now()).map(([kind, p]) => [kind, { until: p.until }]),
      ),
    };
  }

  /** End the rests `sel` names — see the module-level `endRests` — and say which kinds they were. */
  endRests(sel: RestSelector): string[] {
    const now = Date.now();
    const ended = [...this.paused]
      .filter(([kind, p]) => p.until > now && (!sel.kinds || sel.kinds.includes(kind)))
      .map(([kind]) => kind);
    if (ended.length === 0) return ended;
    for (const kind of ended) this.paused.delete(kind);
    this.restsEnded.abort();
    this.restsEnded = new AbortController();
    logger.info('kind rests ended', { pool: this.poolPath, kinds: ended });
    return ended;
  }

  async stop(): Promise<void> {
    // Hang up every claimed step at once, before the first await: a service stop
    // SIGTERMs the step commands too, and a run must see the hang-up when its
    // command returns, or it records the stop as the step failing. A run that
    // sees it writes nothing; one that finished first settled its job itself,
    // and the reset and release below are no-ops for it.
    this.running = false;
    this.abort.abort();
    liveWorkers.delete(this.owner);
    const claimed = [...this.inFlight.values()];
    for (const { abort } of claimed) abort.abort();

    if (this.bashrcSubscription) {
      try {
        await this.bashrcSubscription.unsubscribe();
      } catch { /* best effort */ }
      this.bashrcSubscription = undefined;
    }

    // Nothing below may race a run still writing to its step or job. The wait
    // is bounded: a step that ignores SIGTERM is abandoned after the kill grace.
    await Promise.allSettled(claimed.map(({ done }) => done));

    // Hand every claimed job straight back rather than letting its lease lapse:
    // a planned stop should not cost the pool a lease timeout of latency. A
    // release, not a failure: the job is claimable at once and keeps its
    // attempts, since the stop is not the step failing.
    for (const { job } of claimed) {
      // Normal settlement always writes the step before releasing the pool job.
      // Shutdown needs the same ordering. Returning a job while its step still
      // says `running` makes the replacement worker reject that job as stale;
      // once it does, the instance has neither an owner nor a job and can only
      // be found by the engine's broad orphan sweep.
      await this.resetStepForStop(job);

      try {
        await this.vfs.poolRelease(ADMIN_ACCESS, this.poolPath, job.id, this.owner);
      } catch { /* job may be gone */ }
    }

    logger.info('pool worker stopped', { pool: this.poolPath });
  }

  /** Restore a claimed step before its job is made claimable by another worker. */
  private async resetStepForStop(job: PoolJob): Promise<void> {
    const msg = job.params as PoolJobParams | null;
    if (!msg?.instancePath || !msg.stepName) return;

    const stepPath = join(msg.instancePath, 'steps', msg.stepName);
    try {
      const step = await this.vfs.get<PipelineStepAttrs>(ADMIN_ACCESS, stepPath);
      if (step.attrs.status !== 'running') return;
      // The release below gives the claim's attempt back, so the step's count does too.
      await this.vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, stepPath, {
        attrs: { status: 'waiting', startedAt: undefined, waitingSince: Date.now(), attempts: job.attempts - 1 },
      });
    } catch (err) {
      // The instance may have been cancelled or removed while the command was
      // stopping. The pool release below is still correct in that case.
      logger.warn('failed to reset pooled step while stopping', {
        job: job.id,
        step: stepPath,
        error: err,
      });
    }
  }

  /**
   * Claim without a signal, which the pool answers immediately rather than parking on.
   *
   * `PoolRegistry.claim` only blocks when it is given a signal — it always tries once first —
   * so omitting the signal is how this asks "is there work of this kind right now?" without
   * committing to wait for it. That is what makes rotation possible at all: a blocking claim
   * scoped to one kind would park on a drained kind forever and never reach the others.
   */
  private async tryClaimKind(kind: string): Promise<PoolJob | null> {
    if (this.isPaused(kind)) return null;
    return await this.vfs.poolClaim(ADMIN_ACCESS, this.poolPath, {
      owner: this.owner,
      offer: this.remaining,
      kinds: [kind],
      leaseMs: this.leaseMs,
    });
  }

  /** Turns after `from` in order, wrapping, excluding `from` itself. */
  private turnsAfter(from: string | undefined): string[] {
    const names = this.turns.map((turn) => turn.name);
    if (from === undefined) return names;
    const at = names.indexOf(from);
    if (at < 0) return names;
    return [...names.slice(at + 1), ...names.slice(0, at)];
  }

  private kindsOfTurn(name: string): string[] {
    return this.turns.find((turn) => turn.name === name)?.kinds ?? [name];
  }

  private turnOfKind(kind: string): string {
    return this.turns.find((turn) => turn.kinds.includes(kind))?.name ?? kind;
  }

  /** A job of the turn's kinds, which take claims in turn, or null when none has one ready. */
  private async tryClaimTurn(name: string): Promise<PoolJob | null> {
    const kinds = this.kindsOfTurn(name);
    const start = this.turnCursor.get(name) ?? 0;
    for (let offset = 0; offset < kinds.length; offset++) {
      const index = (start + offset) % kinds.length;
      const job = await this.tryClaimKind(kinds[index]);
      if (job) {
        this.turnCursor.set(name, (index + 1) % kinds.length);
        return job;
      }
    }
    return null;
  }

  private isTurnPaused(name: string): boolean {
    return this.kindsOfTurn(name).every((kind) => this.isPaused(kind));
  }

  /**
   * Stay on one kind until it drains or its quantum expires, then rotate to another kind that
   * actually has work. See `kindQuantumMs` for what the quantum holds back.
   *
   * Order matters here. The expired quantum is checked *before* the current kind, or a kind
   * with an endless supply of work would hold the card forever and the quantum would never be
   * reached — which is the starvation this exists to prevent.
   *
   * Falls back to a blocking claim across every kind when nothing is available anywhere, so an
   * idle worker parks instead of spinning through kinds.
   */
  private async claimBatched(): Promise<PoolJob | null | undefined> {
    const expired = this.currentKind !== undefined &&
      Date.now() - this.kindSince >= this.kindQuantumMs;

    if (expired) {
      // Do not cross a rotation boundary while commands of the old kind are
      // still preparing, inferring, or finalising. With concurrency > 1 that
      // would run two large model families together even though `currentKind`
      // advertises only the new one. Park until the whole batch drains first —
      // for at most `KIND_BOUNDARY_MAX_MS`.
      if (this.holdAtBoundary()) return undefined;
      for (const kind of this.turnsAfter(this.currentKind)) {
        const job = await this.tryClaimTurn(kind);
        if (job) {
          logger.info('kind quantum expired, rotating', {
            pool: this.poolPath,
            from: this.currentKind,
            to: kind,
            heldMs: Date.now() - this.kindSince,
          });
          this.currentKind = kind;
          this.kindSince = Date.now();
          return job;
        }
      }
      // Nothing else wants the card, so keep the current kind and restart its quantum rather
      // than rotating to a kind with no work and immediately rotating back.
      this.kindSince = Date.now();
    }

    if (this.currentKind !== undefined) {
      const job = await this.tryClaimTurn(this.currentKind);
      if (job) return job;
      // The ready queue drained, but an earlier command of this kind has not.
      // Keep the family boundary intact until that last command settles — unless the kind is
      // resting, when there is nothing of it to wait for, or the wait has run its course.
      if (!this.isTurnPaused(this.currentKind) && this.holdAtBoundary()) return undefined;
    }

    for (const kind of this.turnsAfter(this.currentKind)) {
      const job = await this.tryClaimTurn(kind);
      if (job) {
        // Only a real rotation is worth a line. The first claim of a worker's life has no
        // previous kind, and logging that as "rotating" reads as churn that never happened.
        if (this.currentKind !== undefined && kind !== this.currentKind) {
          logger.info('kind drained, rotating', { pool: this.poolPath, from: this.currentKind, to: kind });
        }
        this.currentKind = kind;
        this.kindSince = Date.now();
        return job;
      }
    }

    // Nothing anywhere. Park on the kinds not resting; whatever arrives first sets the next
    // batch. A resting kind wakes the park when its pause ends.
    const job = await this.parkedClaim(this.remaining);
    if (job) {
      this.currentKind = this.turnOfKind(job.kind);
      this.kindSince = Date.now();
    }
    return job;
  }

  private hasCurrentKindInFlight(): boolean {
    return this.currentKind !== undefined &&
      [...this.inFlight.values()].some(({ job }) => this.kindsOfTurn(this.currentKind!).includes(job.kind));
  }

  /**
   * Whether to keep free slots idle at a kind boundary: while the old kind still has commands in
   * flight, for up to `KIND_BOUNDARY_MAX_MS`. Past that the boundary is crossed — the old kind's
   * last command is a long one, and the other slots work beside it rather than wait it out.
   */
  private holdAtBoundary(): boolean {
    if (!this.hasCurrentKindInFlight()) {
      this.boundarySince = undefined;
      return false;
    }
    const now = Date.now();
    this.boundarySince ??= now;
    if (now - this.boundarySince < KIND_BOUNDARY_MAX_MS) return true;
    logger.info('kind boundary crossed: the old kind is still running', {
      pool: this.poolPath,
      kind: this.currentKind,
      heldMs: now - this.boundarySince,
    });
    this.boundarySince = undefined;
    return false;
  }

  /**
   * Keep the configured tail of capacity available to preferred work when
   * such work exists. Earlier claims still use the pool's normal priority,
   * so entry work fills the unreserved share. A non-blocking preferred probe
   * keeps an empty reserved lane work-conserving.
   */
  private async claimWithReservation(): Promise<PoolJob | null | undefined> {
    if (this.accumulatingFor !== undefined) {
      const held = await this.claimAccumulated(this.accumulatingFor);
      if (held !== null) return held;
    }

    const atBoundary = this.reserveKinds.length > 0 &&
      Object.entries(this.reserveCapacity).some(([key, value]) => value > 0 && (this.remaining[key] ?? 0) <= value);
    const reservationBudget = this.remainingReservation();
    const reservedOffer = { ...this.remaining };
    for (const key of Object.keys(this.reserveCapacity)) {
      reservedOffer[key] = Math.min(this.remaining[key] ?? 0, reservationBudget[key] ?? 0);
    }
    const reservationAvailable = Object.entries(this.reserveCapacity).some(([key]) => (reservationBudget[key] ?? 0) > 0);

    if (atBoundary && reservationAvailable) {
      // The reserved share rotates by kind. Strict priority still governs the
      // unreserved share and jobs within each kind, while the rotation gives
      // every downstream stage a bounded turn under a permanent mixed backlog.
      for (let offset = 0; offset < this.reserveKinds.length; offset++) {
        const index = (this.reserveCursor + offset) % this.reserveKinds.length;
        const kind = this.reserveKinds[index];
        if (this.isPaused(kind)) continue;
        const reserved = await this.vfs.poolClaim(ADMIN_ACCESS, this.poolPath, {
          owner: this.owner,
          offer: reservedOffer,
          kinds: [kind],
          leaseMs: this.leaseMs,
        });
        if (reserved) {
          this.reserveCursor = (index + 1) % this.reserveKinds.length;
          return reserved;
        }

        // It is this kind's turn, and what it has ready needs more than the
        // reserved share offers. Let it take from everything that is free,
        // holding that across completions if it is still not enough, instead
        // of handing the slot to the next one-slot kind.
        if (await this.waitingOnCapacity(kind, reservedOffer)) {
          this.accumulatingFor = kind;
          this.reserveCursor = index;
          const held = await this.claimAccumulated(kind);
          if (held !== null) return held;
        }
      }
    }

    if (this.reserveKinds.length > 0) {
      const job = await this.claimShare();
      if (job) return job;
    }
    return await this.parkedClaim(this.remaining);
  }

  /**
   * A claim outside the reserved share: the other kinds by priority, then the reserved kinds in
   * turn. Every reserved kind in flight counts against the reserved share, so once the
   * highest-priority one fills it the rotation above does not run; by priority alone that kind
   * would then take every slot while it has work, and the other reserved kinds none — a crawl's
   * stills before its transcodes, fingerprints and face assignments for hours (ein/core#734).
   * In turn, each kind with work gets slots. Priority still orders the jobs within a kind, and
   * the other kinds, entry work such as ingest, still come first. Null when nothing is ready,
   * for the blocking claim to wait on.
   */
  private async claimShare(): Promise<PoolJob | null> {
    const others = this.kinds.filter((kind) => !this.reserveKinds.includes(kind) && !this.isPaused(kind));
    if (others.length > 0) {
      const job = await this.vfs.poolClaim(ADMIN_ACCESS, this.poolPath, {
        owner: this.owner,
        offer: this.remaining,
        kinds: others,
        leaseMs: this.leaseMs,
      });
      if (job) return job;
    }
    for (let offset = 0; offset < this.reserveKinds.length; offset++) {
      const index = (this.shareCursor + offset) % this.reserveKinds.length;
      const job = await this.tryClaimKind(this.reserveKinds[index]);
      if (job) {
        this.shareCursor = (index + 1) % this.reserveKinds.length;
        return job;
      }
    }
    return null;
  }

  /**
   * A blocking claim over every kind that is not resting. It also returns, with null, when the
   * first pause ends or `endRests` ends one, so the caller re-decides with that kind back in; the
   * claim loop tells that null from a stop by `running`. With no kinds declared, nothing can be
   * left out, and a pause holds back only the job it was taken for (it is released with the pause
   * as its delay).
   */
  private async parkedClaim(offer: Record<string, number>): Promise<PoolJob | null> {
    const now = Date.now();
    const resting = this.kinds.filter((kind) => this.isPaused(kind, now));
    const kinds = this.kinds.length > 0 ? this.kinds.filter((kind) => !resting.includes(kind)) : undefined;
    const wake = resting.length > 0 ? Math.min(...resting.map((kind) => this.paused.get(kind)!.until)) - now : undefined;
    const parked = AbortSignal.any([this.abort.signal, this.restsEnded.signal]);

    if (kinds !== undefined && kinds.length === 0) {
      await this.sleep(Math.max(0, wake ?? 0), parked);
      return null;
    }

    const signal = wake === undefined ? parked : AbortSignal.any([parked, AbortSignal.timeout(Math.max(1, wake))]);
    return await this.vfs.poolClaim(ADMIN_ACCESS, this.poolPath, {
      owner: this.owner,
      offer,
      kinds,
      leaseMs: this.leaseMs,
    }, signal);
  }

  private isPaused(kind: string, now = Date.now()): boolean {
    const pause = this.paused.get(kind);
    return pause !== undefined && pause.until > now;
  }

  /** Rest `kind` for its next pause — doubling the last one — and say how long. */
  private pauseKind(kind: string): number {
    const last = this.paused.get(kind);
    const ms = last ? Math.min(last.ms * 2, TEMPORARY_PAUSE_MAX_MS) : TEMPORARY_PAUSE_MS;
    this.paused.set(kind, { until: Date.now() + ms, ms });
    return ms;
  }

  /**
   * A kind being accumulated for gets the next claim, offered everything
   * that is free rather than the reserved share alone, and keeps getting it
   * until the job fits.
   *
   * The reserved share is the reservation minus every downstream job in
   * flight, so with six one-slot downstream kinds sharing two reserved slots
   * it is at most one slot whenever any of them is running — which under a
   * crawl is always. Measured against that share a two-slot transcode never
   * fits while one-slot jobs keep being admitted around it. Offering the whole free budget
   * means the hold ends at the next completion of *any* kind, at the cost of
   * the weighted job sometimes borrowing an unreserved slot; the reservation
   * is soft in both directions, and the borrowed slot is already counted
   * against the next reserved probe.
   *
   * Returns the job, `undefined` while the hold continues, or `null` when
   * the hold is released because nothing of that kind is waiting on capacity
   * any more (claimed elsewhere, cancelled, or now blocked by something a
   * completion cannot fix).
   */
  private async claimAccumulated(kind: string): Promise<PoolJob | null | undefined> {
    const job = await this.tryClaimKind(kind);
    if (job) {
      this.accumulatingFor = undefined;
      const index = this.reserveKinds.indexOf(kind);
      if (index >= 0) this.reserveCursor = (index + 1) % this.reserveKinds.length;
      return job;
    }
    if (await this.waitingOnCapacity(kind, this.remaining)) {
      logger.debug('holding capacity for a weighted job', { pool: this.poolPath, kind, remaining: { ...this.remaining } });
      return undefined;
    }
    this.accumulatingFor = undefined;
    return null;
  }

  /** Reserved capacity not already occupied by any in-flight preferred kind. */
  private remainingReservation(): Record<string, number> {
    const used: Record<string, number> = {};
    for (const { job } of this.inFlight.values()) {
      if (!this.reserveKinds.includes(job.kind)) continue;
      for (const [key, value] of Object.entries(job.requires)) {
        used[key] = (used[key] ?? 0) + value;
      }
    }

    const offer = { ...this.capacity };
    for (const [key, value] of Object.entries(this.reserveCapacity)) {
      offer[key] = Math.max(0, value - (used[key] ?? 0));
    }
    return offer;
  }

  /**
   * Whether `kind` has a ready job that `offer` alone keeps out: it needs
   * more than that offer and would fit the worker with everything free.
   * Only such a job is worth holding for — accumulating changes nothing for
   * one that fits already but was refused for another reason, such as an
   * `exclusive` class held elsewhere, and a hold on it would only stall
   * admission until its holder happened to finish.
   */
  private async waitingOnCapacity(kind: string, offer: Record<string, number>): Promise<boolean> {
    const now = Date.now();
    const jobs = await this.vfs.poolJobs(ADMIN_ACCESS, this.poolPath, {
      state: 'ready',
      kind,
      limit: 100,
    });
    return jobs.some((job) =>
      job.availableAt.getTime() <= now &&
      Object.entries(job.requires).every(([key, value]) => value <= (this.capacity[key] ?? 0)) &&
      Object.entries(job.requires).some(([key, value]) => value > (offer[key] ?? 0))
    );
  }

  /**
   * One claim at a time, blocking until something the remaining capacity can run
   * shows up. A full worker parks until a slot frees rather than spinning.
   */
  private async claimLoop(): Promise<void> {
    while (this.running) {
      if (this.inFlight.size >= this.concurrency) {
        await this.waitForSlot();
        continue;
      }
      // Do not enter a blocking pool claim with an exhausted capacity offer.
      // Its request would remain parked while a completion mutates `remaining`,
      // bypassing reservation/rotation policy when the registry retries it.
      // Re-enter the decision path after the slot frees instead.
      if (this.capacityExhausted()) {
        await this.waitForSlot();
        continue;
      }

      let job: PoolJob | null | undefined = null;

      try {
        job = this.kindQuantumMs > 0 ? await this.claimBatched() : await this.claimWithReservation();
      } catch (err) {
        if (!this.running) return;
        logger.error('claim failed', { pool: this.poolPath, error: err });
        await this.sleep(1000);
        continue;
      }

      // undefined is the deliberate batch-drain barrier. It differs from null,
      // which is a genuine abort — the pool never reports "nothing" that way.
      if (job === undefined) {
        // Held at a kind boundary: woken by a completion, or when the hold runs out.
        const left = this.boundarySince === undefined ? undefined : KIND_BOUNDARY_MAX_MS - (Date.now() - this.boundarySince);
        await this.waitForSlot(left === undefined ? undefined : Math.max(0, left) + 1);
        continue;
      }
      // null is a stop, or a park that ended because a resting kind's pause did (`parkedClaim`).
      if (!job) {
        if (!this.running) return;
        continue;
      }

      this.commit(job, -1);
      const jobAbort = new AbortController();
      const entry = { job, abort: jobAbort, done: Promise.resolve() };
      this.inFlight.set(job.id, entry);

      entry.done = this.run(job, jobAbort).catch((err) => {
        logger.error('job run error', { job: job.id, error: err });
      }).finally(() => {
        this.inFlight.delete(job.id);
        this.commit(job, +1);
        this.slotFreed?.();
      });
    }
  }

  private slotFreed: (() => void) | undefined;

  private capacityExhausted(): boolean {
    const resources = Object.keys(this.capacity);
    return resources.length > 0 && resources.every((key) => (this.remaining[key] ?? 0) <= 0);
  }

  /** Until a claimed job settles, the worker stops, or `timeoutMs` passes. */
  private waitForSlot(timeoutMs?: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.slotFreed = undefined;
        this.abort.signal.removeEventListener('abort', done);
        resolve();
      };

      const timer = timeoutMs === undefined ? undefined : setTimeout(done, timeoutMs);
      this.slotFreed = done;
      this.abort.signal.addEventListener('abort', done, { once: true });
    });
  }

  /** Move a job's requirements in or out of the remaining budget. */
  private commit(job: PoolJob, sign: 1 | -1): void {
    for (const [key, value] of Object.entries(job.requires)) {
      this.remaining[key] = (this.remaining[key] ?? 0) + sign * value;
    }
  }

  private async run(job: PoolJob, jobAbort: AbortController): Promise<void> {
    const msg = job.params as PoolJobParams | null;

    if (!msg?.instancePath || !msg.stepName || !msg.command) {
      await this.releaseJob(job, () => this.vfs.poolFail(ADMIN_ACCESS, this.poolPath, job.id, this.owner, 'malformed job params'));
      return;
    }

    const stepPath = join(msg.instancePath, 'steps', msg.stepName);

    // The step node, not the job, is the source of truth for whether this work
    // is still wanted.
    const drop = await this.staleReason(stepPath, msg.instancePath);

    if (drop) {
      await this.releaseJob(job, () => this.vfs.poolComplete(ADMIN_ACCESS, this.poolPath, job.id, this.owner, { skipped: drop }));
      logger.info('dropped stale job', { step: msg.stepName, instance: msg.instancePath, reason: drop });
      return;
    }

    // Hung up while validating: the step is still 'waiting', and whoever hung
    // up settles the job.
    if (jobAbort.signal.aborted) return;

    const heartbeat = this.startHeartbeat(job, jobAbort);

    try {
      await this.vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, stepPath, {
        attrs: { status: 'running', startedAt: Date.now(), outputAt: undefined, attempts: job.attempts },
      });

      const { code, stdout, stderr } = await this.runStep(msg.command, stepPath, jobAbort.signal, msg.attribution);

      // Hung up mid-step, and the command was stopped with it. Either the
      // worker is stopping, and `stop()` settles the job once this returns, or
      // the lease was lost (swept, cancelled, reclaimed) and another owner
      // drives this step now. Either way, stop writing to it.
      if (jobAbort.signal.aborted) {
        if (this.running) logger.error('lease lost mid-step, abandoning', { step: msg.stepName, instance: msg.instancePath });
        return;
      }

      if (code === 0) {
        // The service this kind needs answered, so whatever rest it was given is over.
        this.paused.delete(job.kind);
        // Step node first, pool job last — see `releaseJob`.
        await this.vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, stepPath, {
          attrs: { status: 'completed', completedAt: Date.now(), exitCode: 0 },
        });
        await this.releaseJob(job, () => this.vfs.poolComplete(ADMIN_ACCESS, this.poolPath, job.id, this.owner, { exitCode: 0 }));
        logger.info('pooled step completed', { step: msg.stepName, instance: msg.instancePath });
        return;
      }

      const detail = stepErrorDetail(code, stdout, stderr);
      const logDetail = stepErrorLogDetail(code, stdout, stderr);

      // The service the step needs could not do it yet: not the step failing. Back to waiting
      // with the attempt given back and the kind resting — however long the service takes,
      // nothing is failed for it. The kind's rest is what holds the job back, so ending the rest
      // (`endRests`) runs it at once; only a worker that declares no kinds, and so cannot leave
      // one out of its claims, releases the job after the pause instead.
      if (code === STEP_EXIT_TEMPORARY) {
        const pauseMs = this.pauseKind(job.kind);
        await this.vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, stepPath, {
          attrs: { status: 'waiting', startedAt: undefined, waitingSince: Date.now(), attempts: job.attempts - 1, exitCode: code, error: detail },
        });
        const delayMs = this.kinds.length > 0 ? 0 : pauseMs;
        await this.releaseJob(job, () => this.vfs.poolRelease(ADMIN_ACCESS, this.poolPath, job.id, this.owner, delayMs));
        logger.warn('pooled step could not run yet, kind resting', {
          step: msg.stepName,
          instance: msg.instancePath,
          kind: job.kind,
          pauseMs,
          detail: logDetail,
        });
        return;
      }

      // The input is the problem: every retry would meet the same bytes.
      if (code === STEP_EXIT_INPUT) {
        await this.vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, stepPath, {
          attrs: { status: 'failed', completedAt: Date.now(), exitCode: code, error: detail, cause: 'input' },
        });
        await this.releaseJob(job, () => this.vfs.poolFail(ADMIN_ACCESS, this.poolPath, job.id, this.owner, detail, { terminal: true }));
        logger.warn('pooled step failed on its input', { step: msg.stepName, instance: msg.instancePath, detail: logDetail });
        return;
      }

      // The pool owns retries: while it still has attempts left the step stays
      // 'waiting' and the job comes back on its own, so only exhaustion is a
      // pipeline-visible failure. Which of the two it is has to be decided here
      // rather than read off `poolFail`'s answer, because the step write has to
      // land first — so apply the pool's own rule to the job we hold. `claim`
      // already counted this attempt and nothing else can touch `attempts`
      // while the lease is ours, so this agrees with `fail()` by construction.
      let terminal = job.attempts >= job.maxAttempts;
      await this.writeStepOutcome(stepPath, terminal, code, detail);

      const failed = await this.releaseJob(job, () => this.vfs.poolFail(ADMIN_ACCESS, this.poolPath, job.id, this.owner, detail));

      // The pool still has the last word. A `pool retry` or a `maxAttempts` edit
      // between the claim and now moves the boundary under us, so reconcile
      // instead of trusting the prediction; a null answer means the job stopped
      // being ours, and then the step is not ours to correct either.
      if (failed && (failed.state === 'failed') !== terminal) {
        terminal = failed.state === 'failed';
        await this.writeStepOutcome(stepPath, terminal, code, detail);
      }

      if (terminal) {
        logger.error('pooled step failed', { step: msg.stepName, instance: msg.instancePath, code, detail: logDetail });
      } else {
        logger.error('pooled step failed, retrying', { step: msg.stepName, instance: msg.instancePath, code, detail: logDetail });
      }
    } finally {
      heartbeat();
    }
  }

  /** The step's own record of a non-zero exit, terminal or awaiting a pool retry. */
  private async writeStepOutcome(stepPath: string, terminal: boolean, code: number, detail: string): Promise<void> {
    await this.vfs.update<PipelineStepAttrs>(
      ADMIN_ACCESS,
      stepPath,
      terminal
        ? { attrs: { status: 'failed', completedAt: Date.now(), exitCode: code, error: detail } }
        : { attrs: { status: 'waiting', startedAt: undefined, waitingSince: Date.now(), exitCode: code, error: detail } },
    );
  }

  /**
   * Hand a finished job back to the pool, retrying a transient failure.
   *
   * Settling a step is two writes in two stores — the step node in the VFS, the
   * job in the pool registry — and they cannot share a transaction, so one has
   * to land first and the choice is not symmetric:
   *
   * - Step written, job not: the job stays `claimed` with nobody heartbeating
   *   it. The pool's sweep reclaims it within `leaseMs + sweepIntervalMs`, and
   *   the next claimer drops it because `staleReason` sees a step that is no
   *   longer `waiting`. The system is built to tolerate this.
   * - Job written, step not: the step sits `running` with no lease left to
   *   expire and no job to reclaim. Nothing routine repairs that — `advanceDAG`
   *   only reaches it when something else advances the instance, and the
   *   admission kick only when the gate is already saturated — so it holds an
   *   `advanceLocks` slot open until the engine restarts.
   *
   * So the step write always goes first and this always goes last, which leaves
   * the tolerated direction as the only reachable one. Retrying here is what
   * keeps the tolerated case rare too: the leaked capacity is real while it lasts,
   * and a pool may have only one unit of it.
   */
  private async releaseJob<T>(job: PoolJob, write: () => Promise<T>): Promise<T | undefined> {
    for (let attempt = 1; attempt <= RELEASE_ATTEMPTS; attempt++) {
      try {
        return await write();
      } catch (err) {
        if (attempt === RELEASE_ATTEMPTS) {
          // Not lost, just slow: the sweep reclaims the lease and the requeued
          // job is dropped as stale. Logged because until then the permit is gone.
          logger.error('releasing job failed, leaving it to the pool sweep', { job: job.id, pool: this.poolPath, error: err });
          return undefined;
        }

        await this.sleep(RELEASE_RETRY_MS * attempt);
      }
    }
  }

  /** Id of the node at `path`, or undefined if nothing is there. */
  private async subjectNodeId(path: string): Promise<string | undefined> {
    try {
      return (await this.vfs.get(ADMIN_ACCESS, path)).id;
    } catch {
      return undefined;
    }
  }

  /** Why this job should be dropped, or undefined if it is still wanted. */
  private async staleReason(stepPath: string, instancePath: string): Promise<string | undefined> {
    let stepAttrs: PipelineStepAttrs;

    try {
      stepAttrs = (await this.vfs.get<PipelineStepAttrs>(ADMIN_ACCESS, stepPath)).attrs;
    } catch {
      return 'step gone';
    }

    if (stepAttrs.status !== 'waiting') {
      return `step is ${stepAttrs.status}`;
    }

    let instanceAttrs: PipelineInstanceAttrs;

    try {
      instanceAttrs = (await this.vfs.get<PipelineInstanceAttrs>(ADMIN_ACCESS, instancePath)).attrs;
    } catch {
      return 'instance gone';
    }

    if (!isLiveInstance(instanceAttrs.status)) {
      return `instance is ${instanceAttrs.status}`;
    }

    // Identity where the instance recorded it, not just existence: a path can
    // come back as a *different* node — see `PipelineInstanceAttrs.triggerNodeId`.
    const subjectId = await this.subjectNodeId(instanceAttrs.triggerPath);

    if (subjectId === undefined || (instanceAttrs.triggerNodeId !== undefined && subjectId !== instanceAttrs.triggerNodeId)) {
      await this.vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, stepPath, {
        attrs: { status: 'skipped', completedAt: Date.now(), error: 'target node missing' },
      });
      return 'target node missing';
    }

    return undefined;
  }

  /**
   * Renew the lease while the step runs. `leaseMs` governs crash detection, not
   * how long a step may take: a step runs for as long as it needs, and the lease
   * says only that this worker is still alive to see it through.
   *
   * A transient failure is retried — only losing the lease outright (the pool no
   * longer says we own the job) aborts, since continuing would let two workers
   * drive one step and would violate an `exclusive` class.
   */
  private startHeartbeat(job: PoolJob, jobAbort: AbortController): () => void {
    const intervalMs = Math.max(1000, Math.floor(this.leaseMs / HEARTBEAT_DIVISOR));

    const timer = setInterval(async () => {
      try {
        const held = await this.vfs.poolHeartbeat(ADMIN_ACCESS, this.poolPath, job.id, this.owner, this.leaseMs);

        if (!held) {
          clearInterval(timer);
          jobAbort.abort();
        }
      } catch {
        // Transient — the next tick retries, and there are several per lease.
      }
    }, intervalMs);

    return () => clearInterval(timer);
  }

  /** Run a step command to its end, or until the job hangs up — see `runStep`. */
  private async runStep(
    command: string,
    stepPath: string,
    signal: AbortSignal,
    attribution?: Attribution,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const output = markOutput(this.vfs, stepPath);
    try {
      return await runStep(this.tty, command, { signal, onOutput: output.onOutput, attribution });
    } finally {
      output.stop();
    }
  }

  /** Resolves after `ms`, or as soon as `signal` aborts. */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  /** Re-source bashrc whenever post-boot module setup adds another bin directory. */
  private async watchBashrc(): Promise<void> {
    if (!this.vfs.subscribe) return;

    this.bashrcSubscription = await this.vfs.subscribe(() => ADMIN_ACCESS, async (event) => {
      if (event.path !== this.bashrcPath) return;
      await this.sourceBashrc();
    }, { eventTypes: ['created', 'updated'] });
  }

  private async sourceBashrc(startup = false): Promise<void> {
    try {
      if (!(await this.vfs.exists(ADMIN_ACCESS, this.bashrcPath))) return;
      await this.tty.run(`source "${this.bashrcPath}"`);
      if (startup) logger.info('sourced bashrc', { path: this.bashrcPath });
      else logger.debug('re-sourced bashrc', { path: this.bashrcPath });
    } catch (err) {
      logger.error('failed to source bashrc', { error: err });
    }
  }
}
