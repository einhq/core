import { POOL_DEFAULTS, PoolCounts, PoolJobState, PoolResourceOptions } from './types.ts';

export type PoolPolicy = typeof POOL_DEFAULTS;

/** Fill a partial attrs bag with the pool defaults. */
export function resolvePolicy(opts?: PoolResourceOptions): PoolPolicy {
  return {
    agingSeconds: opts?.agingSeconds ?? POOL_DEFAULTS.agingSeconds,
    agingBoost: opts?.agingBoost ?? POOL_DEFAULTS.agingBoost,
    agingMax: opts?.agingMax ?? POOL_DEFAULTS.agingMax,
    leaseMs: opts?.leaseMs ?? POOL_DEFAULTS.leaseMs,
    maxAttempts: opts?.maxAttempts ?? POOL_DEFAULTS.maxAttempts,
    backoffMs: opts?.backoffMs ?? POOL_DEFAULTS.backoffMs,
    backoffMaxMs: opts?.backoffMaxMs ?? POOL_DEFAULTS.backoffMaxMs,
    sweepIntervalMs: opts?.sweepIntervalMs ?? POOL_DEFAULTS.sweepIntervalMs,
  };
}

/**
 * A non-finite requirement would make a job silently unclaimable forever — the
 * only symptom being work that never runs. Reject it at the door instead.
 */
export function validateVector(vector: Record<string, number> | undefined, what: string): Record<string, number> {
  if (!vector) {
    return {};
  }

  for (const [key, value] of Object.entries(vector)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${what}.${key} must be a finite number`);
    }
  }

  return vector;
}

/** True when the offer covers every requirement. A missing key counts as 0. */
export function matches(requires: Record<string, number>, offer: Record<string, number>): boolean {
  for (const [key, value] of Object.entries(requires)) {
    if (!Number.isFinite(value) || value > (offer[key] ?? 0)) {
      return false;
    }
  }

  return true;
}

/** Exponential backoff, capped. `attempts` is the count of starts so far. */
export function backoffMsFor(policy: PoolPolicy, attempts: number): number {
  return Math.min(policy.backoffMaxMs, policy.backoffMs * 2 ** Math.min(attempts, 16));
}

function emptyCounts(): PoolCounts {
  return { ready: 0, claimed: 0, done: 0, failed: 0, cancelled: 0, total: 0 };
}

/**
 * Sum (kind, state, count) rows into a pool's totals and its per-kind split.
 * A (kind, state) pair may come more than once: live jobs and purged ones are
 * counted apart and added here.
 */
export function tallyCounts(rows: Iterable<{ kind: string; state: PoolJobState; count: number; oldestAt?: number }>): {
  counts: PoolCounts;
  byKind: Record<string, PoolCounts>;
  oldestReadyAt: Record<string, number>;
} {
  const counts = emptyCounts();
  const byKind: Record<string, PoolCounts> = {};
  const oldestReadyAt: Record<string, number> = {};

  for (const { kind, state, count, oldestAt } of rows) {
    const perKind = byKind[kind] ??= emptyCounts();
    perKind[state] += count;
    perKind.total += count;
    counts[state] += count;
    counts.total += count;
    if (state === 'ready' && oldestAt !== undefined && !(oldestReadyAt[kind] <= oldestAt)) oldestReadyAt[kind] = oldestAt;
  }

  return { counts, byKind, oldestReadyAt };
}
