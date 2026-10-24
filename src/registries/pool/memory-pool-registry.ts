import { ensureResource, ResourceMode } from '../types.ts';
import { backoffMsFor, matches, PoolPolicy, resolvePolicy, tallyCounts, validateVector } from './lib.ts';
import { PoolHandle } from './pool-handle.ts';
import {
  PoolClaimRequest,
  PoolCounts,
  PoolFailOptions,
  PoolIO,
  PoolJob,
  PoolJobFilter,
  PoolJobId,
  PoolJobInput,
  PoolJobSelector,
  PoolJobState,
  PoolPurgeOptions,
  PoolRegistryIf,
  PoolResourceOptions,
  PoolStat,
  PoolSweepResult,
} from './types.ts';

const TERMINAL: PoolJobState[] = ['done', 'failed', 'cancelled'];

type Pool = {
  policy: PoolPolicy;
  createdAt: Date;
  /** Purged jobs by `kind state`, so terminal counts survive the purge. */
  purged: Map<string, { kind: string; state: PoolJobState; count: number }>;
};

/**
 * In-memory pool. The reference implementation of the semantics the PostgreSQL
 * registry reproduces in SQL — the shared conformance suite runs against both,
 * so any behavioural difference is a bug in one of them.
 *
 * Claiming is atomic for free here: the critical section (select a job, mark it
 * claimed) contains no `await`, so no other task can interleave.
 */
export class MemoryPoolRegistry implements PoolRegistryIf {
  private pools = new Map<string, Pool>();
  private allJobs = new Map<PoolJobId, PoolJob>();
  private nextJobId = 1;
  private listeners = new Map<string, Set<() => void>>();
  /** Per pool, so a busy pool's sweep cadence cannot starve a quiet one's. */
  private lastSweep = new Map<string, number>();
  /** Runs only while a blocking claim is waiting; see {@link ensureTicker}. */
  private ticker: ReturnType<typeof setInterval> | undefined;
  private tickerRefs = 0;

  async init(): Promise<void> {
    // Nothing to set up: no schema, no external connection.
  }

  async dispose(): Promise<void> {
    this.stopTicker();

    // Unblock anything parked in a blocking claim before dropping the data.
    for (const set of this.listeners.values()) {
      for (const cb of set) cb();
    }

    this.pools.clear();
    this.allJobs.clear();
    this.listeners.clear();
  }

  async touch(id: string, opts: PoolResourceOptions): Promise<boolean> {
    const policy = resolvePolicy(opts);
    const existing = this.pools.get(id);

    if (!existing) {
      this.pools.set(id, { policy, createdAt: new Date(), purged: new Map() });
      return true;
    }

    if (samePolicy(existing.policy, policy)) {
      return false;
    }

    existing.policy = policy;
    return true;
  }

  async open(id: string, opts: PoolResourceOptions, mode?: ResourceMode): Promise<PoolHandle> {
    const { truncate } = await ensureResource(this, id, opts, mode);

    if (truncate) {
      this.truncate(id);
    }

    const io: PoolIO = {
      page: (afterId, limit) => this.listJobs(id, { state: 'ready', afterId, limit }),
      add: (job) => this.add(id, job),
    };

    const handle = new PoolHandle(id, opts, mode || 'r', this, io);
    await handle.init();

    return handle;
  }

  async exists(id: string): Promise<boolean> {
    return this.pools.has(id);
  }

  async stat(id: string): Promise<PoolStat> {
    const pool = this.requirePool(id);
    const { counts, byKind, oldestReadyAt } = this.tally(id);

    return { size: counts.ready, counts, byKind, oldestReadyAt, ...pool.policy };
  }

  async statX(id: string): Promise<PoolStat> {
    return await this.stat(id);
  }

  async delete(id: string): Promise<boolean> {
    if (!this.pools.has(id)) {
      return false;
    }

    this.pools.delete(id);

    for (const [jobId, job] of this.allJobs) {
      if (job.poolId === id) {
        this.allJobs.delete(jobId);
      }
    }

    const set = this.listeners.get(id);
    if (set) {
      for (const cb of set) cb();
      this.listeners.delete(id);
    }

    return true;
  }

  async list(): Promise<AsyncIterable<string>> {
    const ids = Array.from(this.pools.keys());

    return (async function* () {
      for (const id of ids) {
        yield id;
      }
    })();
  }

  async count(_id?: string): Promise<number> {
    return this.pools.size;
  }

  // ===== Pool operations =====

  async add(id: string, input: PoolJobInput): Promise<PoolJob> {
    const pool = this.requirePool(id);

    if (!input.kind) {
      throw new Error('job kind is required');
    }

    const requires = validateVector(input.requires, 'requires');
    const priority = input.priority ?? 0;
    const availableAt = new Date(Date.now() + (input.delayMs ?? 0));

    // Idempotent enqueue: a retry, a re-advance or a restart all land on the
    // same job rather than appending a duplicate nobody will ever reap.
    if (input.dedupKey) {
      const live = this.liveByDedupKey(id, input.dedupKey);

      if (live) {
        live.priority = Math.max(live.priority, priority);
        live.effPriority = Math.max(live.effPriority, priority);
        live.availableAt = new Date(Math.min(live.availableAt.getTime(), availableAt.getTime()));
        this.notify(id);
        return { ...live };
      }
    }

    const job: PoolJob = {
      id: this.nextJobId++,
      poolId: id,
      kind: input.kind,
      state: 'ready',
      priority,
      effPriority: priority,
      requires,
      params: input.params ?? null,
      dedupKey: input.dedupKey,
      exclusive: input.exclusive,
      attempts: Math.max(0, Math.floor(input.attempts ?? 0)),
      maxAttempts: input.maxAttempts ?? pool.policy.maxAttempts,
      availableAt,
      createdAt: new Date(),
    };

    this.allJobs.set(job.id, job);
    this.notify(id);

    return { ...job };
  }

  async claim(id: string, req: PoolClaimRequest, signal?: AbortSignal): Promise<PoolJob | null> {
    this.requirePool(id);
    validateVector(req.offer, 'offer');

    const job = this.tryClaim(id, req);

    if (job) {
      return job;
    }

    if (!signal) {
      return null;
    }

    return await new Promise<PoolJob | null>((resolve) => {
      const attempt = () => {
        const job = this.tryClaim(id, req);
        if (job) {
          cleanup();
          resolve(job);
        }
      };

      const onAbort = () => {
        cleanup();
        resolve(null);
      };

      const removeListener = this.addListener(id, attempt);
      const stopTicker = this.ensureTicker();

      const cleanup = () => {
        removeListener();
        stopTicker();
        signal.removeEventListener('abort', onAbort);
      };

      signal.addEventListener('abort', onAbort, { once: true });

      if (signal.aborted) {
        onAbort();
      }
    });
  }

  async heartbeat(id: string, jobId: PoolJobId, owner: string, leaseMs?: number): Promise<boolean> {
    const pool = this.requirePool(id);
    const job = this.allJobs.get(jobId);

    if (!job || job.poolId !== id || job.state !== 'claimed' || job.leaseOwner !== owner) {
      return false;
    }

    job.leaseUntil = new Date(Date.now() + (leaseMs ?? pool.policy.leaseMs));
    return true;
  }

  async complete(id: string, jobId: PoolJobId, owner: string, result?: unknown): Promise<PoolJob | null> {
    const job = this.ownedJob(id, jobId, owner);

    if (!job) {
      return null;
    }

    job.state = 'done';
    job.finishedAt = new Date();
    job.result = result ?? null;
    job.leaseOwner = undefined;
    job.leaseUntil = undefined;

    // Completing frees the exclusivity class, so a waiter can proceed.
    this.notify(id);

    return { ...job };
  }

  async fail(id: string, jobId: PoolJobId, owner: string, error: string, opts: PoolFailOptions = {}): Promise<PoolJob | null> {
    const pool = this.requirePool(id);
    const job = this.ownedJob(id, jobId, owner);

    if (!job) {
      return null;
    }

    job.error = error;
    job.leaseOwner = undefined;
    job.leaseUntil = undefined;
    job.claimedAt = undefined;

    if (opts.terminal || job.attempts >= job.maxAttempts) {
      job.state = 'failed';
      job.finishedAt = new Date();
    } else {
      job.state = 'ready';
      job.availableAt = new Date(Date.now() + backoffMsFor(pool.policy, job.attempts));
    }

    this.notify(id);

    return { ...job };
  }

  async release(id: string, jobId: PoolJobId, owner: string, delayMs = 0): Promise<PoolJob | null> {
    const job = this.ownedJob(id, jobId, owner);

    if (!job) {
      return null;
    }

    job.state = 'ready';
    job.attempts = Math.max(0, job.attempts - 1);
    job.availableAt = new Date(Date.now() + Math.max(0, delayMs));
    job.leaseOwner = undefined;
    job.leaseUntil = undefined;
    job.claimedAt = undefined;

    this.notify(id);

    return { ...job };
  }

  async cancel(id: string, sel: PoolJobSelector): Promise<number> {
    this.requirePool(id);
    let count = 0;

    for (const job of this.allJobs.values()) {
      if (job.poolId !== id || TERMINAL.includes(job.state)) {
        continue;
      }

      if (!selectorMatches(job, sel)) {
        continue;
      }

      job.state = 'cancelled';
      job.finishedAt = new Date();
      job.leaseOwner = undefined;
      job.leaseUntil = undefined;
      count++;
    }

    if (count > 0) {
      this.notify(id);
    }

    return count;
  }

  async retry(id: string, sel: PoolJobSelector): Promise<number> {
    this.requirePool(id);
    let count = 0;

    for (const job of this.allJobs.values()) {
      if (job.poolId !== id || !TERMINAL.includes(job.state) || !selectorMatches(job, sel)) {
        continue;
      }

      // A retry is a fresh start, not a resumption: an exhausted job would
      // otherwise be reclaimed straight back to failed by the next sweep.
      job.state = 'ready';
      job.attempts = 0;
      job.availableAt = new Date();
      job.finishedAt = undefined;
      job.error = undefined;
      job.result = undefined;
      count++;
    }

    if (count > 0) {
      this.notify(id);
    }

    return count;
  }

  async purge(id: string, opts?: PoolPurgeOptions): Promise<number> {
    const pool = this.requirePool(id);

    const states = new Set(opts?.state === undefined ? TERMINAL : Array.isArray(opts.state) ? opts.state : [opts.state]);
    const cutoff = opts?.olderThanMs === undefined ? undefined : Date.now() - opts.olderThanMs;
    let count = 0;

    for (const [jobId, job] of this.allJobs) {
      if (job.poolId !== id || !states.has(job.state)) continue;
      // A job with no finish time is never old enough, as in SQL, where the comparison is NULL.
      if (cutoff !== undefined && (job.finishedAt === undefined || job.finishedAt.getTime() > cutoff)) continue;

      this.allJobs.delete(jobId);
      const key = `${job.kind} ${job.state}`;
      const banked = pool.purged.get(key) ?? { kind: job.kind, state: job.state, count: 0 };
      banked.count++;
      pool.purged.set(key, banked);
      count++;
    }

    return count;
  }

  async get(id: string, jobId: PoolJobId): Promise<PoolJob | null> {
    const job = this.allJobs.get(jobId);
    return job && job.poolId === id ? { ...job } : null;
  }

  async jobs(id: string, filter?: PoolJobFilter): Promise<PoolJob[]> {
    this.requirePool(id);
    return await this.listJobs(id, filter);
  }

  async counts(id: string): Promise<PoolCounts> {
    this.requirePool(id);
    return this.tally(id).counts;
  }

  /** Live jobs plus purged ones, summed per state and per kind. */
  private tally(id: string): ReturnType<typeof tallyCounts> {
    const pool = this.requirePool(id);
    const live = [...this.allJobs.values()].filter((job) => job.poolId === id).map((job) => ({
      kind: job.kind,
      state: job.state,
      count: 1,
      oldestAt: job.createdAt.getTime(),
    }));
    return tallyCounts([...live, ...pool.purged.values()]);
  }

  async sweep(id?: string): Promise<PoolSweepResult> {
    const result: PoolSweepResult = { reclaimed: 0, failed: 0, promoted: 0 };
    const now = Date.now();
    const touched = new Set<string>();

    for (const job of this.allJobs.values()) {
      if (id !== undefined && job.poolId !== id) {
        continue;
      }

      const pool = this.pools.get(job.poolId);
      if (!pool) {
        continue;
      }

      // Expired lease: the worker died without reporting. Attempts already
      // counted the start, so a poison job stops crash-looping on its own.
      if (job.state === 'claimed' && job.leaseUntil && job.leaseUntil.getTime() < now) {
        job.leaseOwner = undefined;
        job.leaseUntil = undefined;
        job.claimedAt = undefined;

        if (job.attempts >= job.maxAttempts) {
          job.state = 'failed';
          job.finishedAt = new Date();
          job.error ??= `lease expired after ${job.attempts} attempts`;
          result.failed++;
        } else {
          job.state = 'ready';
          job.availableAt = new Date(now + backoffMsFor(pool.policy, job.attempts));
          result.reclaimed++;
        }

        touched.add(job.poolId);
        continue;
      }

      if (job.state !== 'ready' || pool.policy.agingSeconds <= 0) {
        continue;
      }

      // Promote at most one bucket per sweep, and only once the job is older
      // than the next bucket boundary. Monotone and order-preserving: an older
      // job reaches every level before a younger one does.
      const gained = job.effPriority - job.priority;

      if (gained >= pool.policy.agingMax) {
        continue;
      }

      const level = Math.floor(gained / Math.max(pool.policy.agingBoost, 1));
      const dueAt = job.createdAt.getTime() + pool.policy.agingSeconds * (level + 1) * 1000;

      if (dueAt <= now) {
        job.effPriority = Math.min(job.effPriority + pool.policy.agingBoost, job.priority + pool.policy.agingMax);
        result.promoted++;
        touched.add(job.poolId);
      }
    }

    for (const poolId of touched) {
      this.notify(poolId);
    }

    return result;
  }

  // ===== Internals =====

  /**
   * Opportunistic maintenance, throttled to the pool's `sweepIntervalMs`. An
   * explicit `sweep()` is never throttled; this is only the background path.
   */
  private sweepIfDue(id: string): void {
    const pool = this.pools.get(id);

    if (!pool) {
      return;
    }

    const now = Date.now();

    if (now - (this.lastSweep.get(id) ?? 0) < pool.policy.sweepIntervalMs) {
      return;
    }

    this.lastSweep.set(id, now);
    void this.sweep(id);
  }

  private requirePool(id: string): Pool {
    const pool = this.pools.get(id);

    if (!pool) {
      throw new Error(`no pool found: ${id}`);
    }

    return pool;
  }

  private ownedJob(id: string, jobId: PoolJobId, owner: string): PoolJob | undefined {
    const job = this.allJobs.get(jobId);

    if (!job || job.poolId !== id || job.state !== 'claimed' || job.leaseOwner !== owner) {
      return undefined;
    }

    return job;
  }

  private liveByDedupKey(poolId: string, dedupKey: string): PoolJob | undefined {
    for (const job of this.allJobs.values()) {
      if (job.poolId === poolId && job.dedupKey === dedupKey && !TERMINAL.includes(job.state)) {
        return job;
      }
    }

    return undefined;
  }

  /**
   * Select and claim in one synchronous pass — no `await` between choosing a
   * job and marking it claimed, which is what makes this atomic.
   */
  private tryClaim(poolId: string, req: PoolClaimRequest): PoolJob | null {
    const pool = this.pools.get(poolId);

    if (!pool) {
      return null;
    }

    const now = Date.now();
    const offer = req.offer ?? {};
    const kinds = req.kinds && req.kinds.length > 0 ? new Set(req.kinds) : undefined;

    // Exclusivity classes currently held. An expired-but-unswept lease still
    // holds its class: fail-safe, and it matches the PG unique index, which
    // cannot reference now().
    const held = new Set<string>();
    for (const job of this.allJobs.values()) {
      if (job.poolId === poolId && job.state === 'claimed' && job.exclusive) {
        held.add(job.exclusive);
      }
    }

    let best: PoolJob | undefined;

    for (const job of this.allJobs.values()) {
      if (job.poolId !== poolId || job.state !== 'ready') continue;
      if (job.availableAt.getTime() > now) continue;
      if (kinds && !kinds.has(job.kind)) continue;
      if (job.exclusive && held.has(job.exclusive)) continue;
      if (!matches(job.requires, offer)) continue;

      if (!best || compare(job, best) < 0) {
        best = job;
      }
    }

    if (!best) {
      return null;
    }

    best.state = 'claimed';
    best.leaseOwner = req.owner;
    best.leaseUntil = new Date(now + (req.leaseMs ?? pool.policy.leaseMs));
    best.claimedAt = new Date(now);
    best.attempts++;

    return { ...best };
  }

  private listJobs(poolId: string, filter?: PoolJobFilter): Promise<PoolJob[]> {
    const states = filter?.state === undefined ? undefined : new Set(Array.isArray(filter.state) ? filter.state : [filter.state]);

    const rows: PoolJob[] = [];

    for (const job of this.allJobs.values()) {
      if (job.poolId !== poolId) continue;
      if (states && !states.has(job.state)) continue;
      if (filter?.kind && job.kind !== filter.kind) continue;
      if (filter?.dedupKey !== undefined && job.dedupKey !== filter.dedupKey) continue;
      if (filter?.afterId !== undefined && job.id <= filter.afterId) continue;

      rows.push({ ...job });
    }

    rows.sort((a, b) => a.id - b.id);

    return Promise.resolve(filter?.limit !== undefined ? rows.slice(0, filter.limit) : rows);
  }

  private truncate(poolId: string): void {
    for (const [jobId, job] of this.allJobs) {
      if (job.poolId === poolId) {
        this.allJobs.delete(jobId);
      }
    }
  }

  private addListener(poolId: string, callback: () => void): () => void {
    let set = this.listeners.get(poolId);

    if (!set) {
      set = new Set();
      this.listeners.set(poolId, set);
    }

    set.add(callback);

    return () => {
      set.delete(callback);
      if (set.size === 0) this.listeners.delete(poolId);
    };
  }

  private notify(poolId: string): void {
    const set = this.listeners.get(poolId);

    if (set) {
      for (const cb of set) cb();
    }
  }

  /**
   * A job can become claimable with no write at all — `availableAt` passing, or
   * a lease expiring — so a notification alone would leave a waiter parked
   * forever. Reference-counted so an idle registry holds no timer: a stray one
   * fails the test tier's resource sanitizer.
   */
  private ensureTicker(): () => void {
    this.tickerRefs++;

    if (this.ticker === undefined) {
      this.ticker = setInterval(() => {
        // Sweep only the pools someone is waiting on, throttled per pool
        // exactly as the PostgreSQL registry throttles its poll — otherwise the
        // two implementations reclaim expired leases on different schedules.
        for (const poolId of [...this.listeners.keys()]) {
          this.sweepIfDue(poolId);
          this.notify(poolId);
        }
      }, TICK_MS);
    }

    let released = false;

    return () => {
      if (released) return;
      released = true;
      this.tickerRefs--;

      if (this.tickerRefs <= 0) {
        this.stopTicker();
      }
    };
  }

  private stopTicker(): void {
    if (this.ticker !== undefined) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }

    this.tickerRefs = 0;
  }
}

/** How often a blocked claim re-checks for time-based eligibility changes. */
const TICK_MS = 250;

/** Scheduling order: effective priority, then oldest, then insertion order. */
function compare(a: PoolJob, b: PoolJob): number {
  return b.effPriority - a.effPriority ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.id - b.id;
}

function selectorMatches(job: PoolJob, sel: PoolJobSelector): boolean {
  if ('jobId' in sel) return job.id === sel.jobId;
  if ('dedupKey' in sel) return job.dedupKey === sel.dedupKey;
  if ('kind' in sel) return job.kind === sel.kind;
  return job.dedupKey !== undefined && job.dedupKey.startsWith(sel.dedupKeyPrefix);
}

function samePolicy(a: PoolPolicy, b: PoolPolicy): boolean {
  return (Object.keys(a) as (keyof PoolPolicy)[]).every((key) => a[key] === b[key]);
}
