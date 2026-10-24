import { RegistryIf, ResourceOptions } from '../types.ts';

/**
 * Pool policy. These are the node attrs — the VFS hands a registry the node's
 * attrs as options — so retuning a pool is an attrs edit with no service
 * restart.
 */
export type PoolResourceOptions = ResourceOptions & {
  /** Seconds of queue age per aging step. 0 (default) disables aging entirely. */
  agingSeconds?: number;
  /** Effective-priority points added per aging step. */
  agingBoost?: number;
  /**
   * Total aging a job can accumulate. Keep this STRICTLY BELOW the gap between
   * priority lanes: aging then reorders within a lane but can never promote a
   * job across a lane boundary. That invariant is what preserves strict
   * lane ordering (e.g. every face job before any describe job, so the model
   * server never has to evict and reload between them).
   *
   * Promotions per job = agingMax / agingBoost — keep it small, each promotion
   * is an indexed row update across the whole ready backlog.
   */
  agingMax?: number;
  /** Default lease (ms) when claim() omits one. */
  leaseMs?: number;
  /** Default maxAttempts for jobs added without one. */
  maxAttempts?: number;
  /** Retry backoff: min(backoffMaxMs, backoffMs * 2^attempts). */
  backoffMs?: number;
  backoffMaxMs?: number;
  /** Maintenance sweep cadence for a registry instance. */
  sweepIntervalMs?: number;
};

/** Defaults applied to a pool row when the attrs omit a policy field. */
export const POOL_DEFAULTS = {
  agingSeconds: 0,
  agingBoost: 1,
  agingMax: 0,
  leaseMs: 60_000,
  maxAttempts: 3,
  backoffMs: 5_000,
  backoffMaxMs: 300_000,
  sweepIntervalMs: 30_000,
} satisfies Required<Omit<PoolResourceOptions, 'streamChunkSize'>>;

/**
 * - `ready`: claimable once `availableAt` passes.
 * - `claimed`: a worker holds a lease; the sweep reclaims it when that expires.
 * - `done` / `failed` / `cancelled`: terminal.
 */
export type PoolJobState = 'ready' | 'claimed' | 'done' | 'failed' | 'cancelled';

export type PoolJobId = number;

export interface PoolJob {
  id: PoolJobId;
  poolId: string;
  /** Categorical capability class, used to filter what a worker will consider. */
  kind: string;
  state: PoolJobState;
  priority: number;
  /** `priority` plus accumulated aging. The scheduling key. */
  effPriority: number;
  requires: Record<string, number>;
  params: unknown;
  dedupKey?: string;
  exclusive?: string;
  attempts: number;
  maxAttempts: number;
  availableAt: Date;
  leaseOwner?: string;
  leaseUntil?: Date;
  createdAt: Date;
  claimedAt?: Date;
  finishedAt?: Date;
  result?: unknown;
  error?: string;
}

export interface PoolJobInput {
  kind: string;
  priority?: number;
  /** Every value must be a finite number; `add` rejects anything else. */
  requires?: Record<string, number>;
  params?: unknown;
  /**
   * Unique among non-terminal jobs of this pool. Re-adding the same key is an
   * upsert, which makes enqueueing idempotent: a retry, a re-advance or a
   * restart all land on the same job instead of appending a duplicate.
   */
  dedupKey?: string;
  /** Mutex class: at most one claimed job per (pool, exclusive) at a time. */
  exclusive?: string;
  maxAttempts?: number;
  /**
   * Attempts already spent on this work: a job added again for a step whose worker died with
   * the last one carries the count over, so a step that kills its worker every time runs out of
   * attempts instead of starting over forever. A re-add of a live job leaves its count alone.
   */
  attempts?: number;
  /** Delay before the job first becomes claimable. */
  delayMs?: number;
}

export interface PoolClaimRequest {
  /** Opaque lease owner, e.g. `${hostname}:${pid}:${slot}`. */
  owner: string;
  /** Remaining capacity. A job is eligible when requires[k] <= offer[k] for every k. */
  offer?: Record<string, number>;
  /** If set, only these kinds are considered. Omit to consider all. */
  kinds?: string[];
  leaseMs?: number;
}

export interface PoolFailOptions {
  terminal?: boolean;
}

export type PoolJobSelector =
  | { jobId: PoolJobId }
  | { dedupKey: string }
  | { dedupKeyPrefix: string }
  /** Every job of one kind — how the leftovers of a renamed or retired kind are cleared. */
  | { kind: string };

export interface PoolJobFilter {
  state?: PoolJobState | PoolJobState[];
  kind?: string;
  /** Exact dedup key. Served by the unique index, so this is a point lookup. */
  dedupKey?: string;
  limit?: number;
  /** Keyset cursor: return jobs with an id greater than this. */
  afterId?: PoolJobId;
}

export interface PoolPurgeOptions {
  /** Which terminal states to drop. Defaults to all three. */
  state?: PoolJobState | PoolJobState[];
  /** Only drop jobs that finished longer ago than this. */
  olderThanMs?: number;
}

export type PoolCounts = Record<PoolJobState, number> & { total: number };

export type PoolStat = {
  /** Claimable backlog (`ready` jobs), so `size` means the same as on a queue. */
  size: number;
  /**
   * Jobs by state. The terminal states include purged jobs, so `done` and
   * `failed` only ever grow (a `retry` aside) and can be differenced into a rate.
   */
  counts: PoolCounts;
  /**
   * The same counts split by job kind.
   *
   * A pool is claimed by capability, not by name, so one pool routinely holds
   * work of wildly different cost — `/var/pools/media` carries face detection,
   * captioning and video transcodes together. A single throughput figure over
   * that mixture answers no useful question: it depends on which kind happened
   * to dominate the window, so an ETA built on it moves when the *mix* changes
   * rather than when the backlog does.
   */
  byKind: Record<string, PoolCounts>;
  /**
   * When the oldest `ready` job of each kind was added (epoch ms), for the kinds with any: how long
   * the work at the back of the line has waited, which a rate alone does not say.
   */
  oldestReadyAt: Record<string, number>;
} & Required<Omit<PoolResourceOptions, 'streamChunkSize'>>;

export interface PoolSweepResult {
  /** Expired leases returned to `ready`. */
  reclaimed: number;
  /** Expired leases that had no attempts left. */
  failed: number;
  /** Jobs whose `effPriority` was aged up a bucket. */
  promoted: number;
}

/** Low-level I/O for a single pool, handed to a {@link PoolHandle}. */
export interface PoolIO {
  /** Keyset page of the ready backlog, for the non-destructive handle read. */
  page(afterId: PoolJobId, limit: number): Promise<PoolJob[]>;
  add(job: PoolJobInput): Promise<PoolJob>;
}

/**
 * Work pool: one shared table of jobs claimed by capability rather than by
 * queue name.
 *
 * Unlike a queue, a pool is not FIFO and reading it is not destructive. Jobs
 * carry a priority, an aging term, a resource requirement vector and an
 * exclusivity class; a worker offers its remaining capacity and gets the best
 * job it can actually run:
 *
 * ```
 *   /var/pools/default
 *     job A  kind=gpu-faces     priority=100  requires={vramMb:3000}
 *     job B  kind=gpu-describe  priority=50   requires={vramMb:4000}
 *     job C  kind=cpu-convert   priority=10   requires={cpu:2}
 *          │
 *          ├── claim(offer={vramMb:16000}) -> A, then B
 *          └── claim(offer={cpu:4})        -> C   (A and B don't match)
 * ```
 *
 * The pool stores nothing about workers: the offer is the entire worker-side
 * input to a claim, so there is no registration and no stale-worker state. A
 * claim takes a lease; a worker renews it while it works and the sweep reclaims
 * it if the worker dies.
 */
export interface PoolRegistryIf extends RegistryIf<PoolResourceOptions, PoolStat> {
  /** Add a job, or upsert it when `dedupKey` matches a live one. */
  add(id: string, job: PoolJobInput): Promise<PoolJob>;
  /**
   * Claim the best matching job under a lease. Blocking when `signal` is given,
   * in which case it resolves null ONLY on a genuine abort.
   */
  claim(id: string, req: PoolClaimRequest, signal?: AbortSignal): Promise<PoolJob | null>;
  /** Extend a lease. False when the job is no longer claimed by `owner`. */
  heartbeat(id: string, jobId: PoolJobId, owner: string, leaseMs?: number): Promise<boolean>;
  complete(id: string, jobId: PoolJobId, owner: string, result?: unknown): Promise<PoolJob | null>;
  /**
   * Retry with backoff until `attempts >= maxAttempts`, then fail terminally. `terminal` fails
   * it now whatever attempts are left: the failure is the input's, and a retry would meet it again.
   */
  fail(id: string, jobId: PoolJobId, owner: string, error: string, opts?: PoolFailOptions): Promise<PoolJob | null>;
  /**
   * Hand a claimed job back as if it had not run: `ready` after `delayMs` (at once by default),
   * with the attempt its claim counted given back. For a worker that stops, and for a step that
   * could not run yet — the service it needs was busy or down — rather than one that failed.
   */
  release(id: string, jobId: PoolJobId, owner: string, delayMs?: number): Promise<PoolJob | null>;
  cancel(id: string, sel: PoolJobSelector): Promise<number>;
  /** Return terminal jobs to `ready` with a clean attempt count. */
  retry(id: string, sel: PoolJobSelector): Promise<number>;
  /**
   * Delete terminal jobs. Without this a pool grows without bound — a full
   * media crawl leaves one `done` row per file per step. What it deletes is
   * banked per kind and state, so the counts of terminal states do not fall.
   */
  purge(id: string, opts?: PoolPurgeOptions): Promise<number>;
  get(id: string, jobId: PoolJobId): Promise<PoolJob | null>;
  jobs(id: string, filter?: PoolJobFilter): Promise<PoolJob[]>;
  /** The pool's `stat().counts`, without the policy. */
  counts(id: string): Promise<PoolCounts>;
  /** Reclaim expired leases, fail exhausted jobs, promote aging. Idempotent. */
  sweep(id?: string): Promise<PoolSweepResult>;
}
