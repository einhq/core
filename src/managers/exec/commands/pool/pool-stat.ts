/**
 * pool-stat — a pool's live counts and policy, and how fast it moves; without a path, every
 * pool's.
 *
 * The counts are the pool's own, now. The rates are not something a pool knows: they are
 * differenced from `metrics-sampler`'s `pools` series over the last hour, per pool and per job
 * kind, because a pool is claimed by capability and one rate over a mixture of face detection and
 * video transcodes tracks the mix rather than the backlog.
 */

import { basename, join } from '@std/path';
import { eta, type PoolCountsEntry, type PoolsEntry, rate, type Sample, within } from '../../../../lib/metrics/mod.ts';
import { POOLS_PATH } from '../../../../lib/paths.ts';
import type { PoolKindThroughput, PoolStatAnswer, PoolThroughput, PoolWorkerInfo } from '../../../../lib/api/system.ts';
import type { PoolStat } from '../../../../registries/pool/mod.ts';
import { TRIGGER_POOL } from '../../../pipeline/mod.ts';
import { poolWorkerStates } from '../../../pipeline/pool-worker.ts';
import { unservableKinds } from '../../../pipeline/unservable.ts';
import { readPoolStat } from './pool-reading.ts';
import { fmtAge, fmtEta, HOUR, RATE_WINDOW_MS, readSeries } from '../system/lib.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

/** 15s cadence -> ~1.2h, the rate window. */
const POOLS_SERIES_LIMIT = 300;

const readPoolsSeries = async (cmd: Command): Promise<Sample<PoolsEntry>[]> => within(await readSeries<PoolsEntry>(cmd, 'pools', POOLS_SERIES_LIMIT), RATE_WINDOW_MS);

const added = (entry: PoolCountsEntry | undefined): number | undefined => entry === undefined ? undefined : entry.ready + entry.claimed + entry.done + entry.failed;
const perHour = (perMs: number | undefined) => perMs === undefined ? undefined : Math.round(perMs * HOUR);

/**
 * One pool's counts beside its rates.
 *
 * `window` is the `pools` series over the rate window, read once by the caller when it asks about
 * several pools.
 */
const poolThroughput = (
  name: string,
  path: string,
  stat: Pick<PoolStat, 'counts' | 'byKind'> & Partial<Pick<PoolStat, 'oldestReadyAt'>>,
  window: Sample<PoolsEntry>[],
  workers: PoolWorkerInfo[] = [],
): PoolThroughput => {
  const unservable = new Map(unservableKinds.unservable().map((entry) => [`${entry.pool}\0${entry.kind}`, entry.since]));
  // A kind several workers offer rests until the last of them tries it again.
  const resting = new Map<string, { until: number }>();
  for (const worker of workers) {
    for (const [kind, rest] of Object.entries(worker.resting)) {
      const known = resting.get(kind);
      if (!known || rest.until > known.until) resting.set(kind, rest);
    }
  }

  const kinds: PoolKindThroughput[] = [];
  for (const [kind, counts] of Object.entries(stat.byKind ?? {})) {
    const kindPerMs = rate(window, (entry) => entry[name]?.byKind?.[kind]?.done);
    const unservableSince = unservable.get(`${name}\0${kind}`);

    kinds.push({
      kind,
      ready: counts.ready,
      claimed: counts.claimed,
      done: counts.done,
      failed: counts.failed,
      perHour: perHour(kindPerMs),
      inPerHour: perHour(rate(window, (entry) => added(entry[name]?.byKind?.[kind]))),
      // A kind nothing offers can still carry a rate for up to an hour — whatever drained
      // before its worker went away — and an ETA from that counts down to a finish that
      // will not come. It would also become the pool's ETA, being the longest.
      etaMs: unservableSince === undefined ? eta(counts.ready + counts.claimed, kindPerMs) : undefined,
      unservableSince,
      oldestReadyAt: stat.oldestReadyAt?.[kind],
      restingUntil: resting.get(kind)?.until,
    });
  }

  kinds.sort((a, b) => (b.etaMs ?? -1) - (a.etaMs ?? -1) || a.kind.localeCompare(b.kind));

  // Kinds drain in parallel — different workers claim different capabilities —
  // so the pool is done when its slowest kind is, not after the sum of them.
  // Falls back to the blended figure while no kind has a rate yet.
  const perMs = rate(window, (entry) => entry[name]?.done);
  const kindEtas = kinds.map((entry) => entry.etaMs).filter((ms): ms is number => ms !== undefined);

  return {
    name,
    path,
    role: name === TRIGGER_POOL ? 'intake' : 'work',
    ready: stat.counts.ready,
    claimed: stat.counts.claimed,
    done: stat.counts.done,
    failed: stat.counts.failed,
    perHour: perHour(perMs),
    inPerHour: perHour(rate(window, (entry) => added(entry[name]))),
    etaMs: kindEtas.length > 0 ? Math.max(...kindEtas) : eta(stat.counts.ready + stat.counts.claimed, perMs),
    kinds: kinds.length > 0 ? kinds : undefined,
  };
};

/** The workers in this process claiming from `path`, and the kind each is on. */
const workersOn = (path: string): PoolWorkerInfo[] =>
  poolWorkerStates()
    .filter((worker) => worker.pool === path)
    .map(({ kinds, currentKind, kindSince, kindQuantumMs, reserveKinds, reserveCapacity, nextReserveKind, accumulatingFor, resting }) => ({
      kinds,
      currentKind,
      kindSince,
      kindQuantumMs,
      reserveKinds,
      reserveCapacity,
      nextReserveKind,
      accumulatingFor,
      resting,
    }));

const answer = (path: string, stat: PoolStat, window: Sample<PoolsEntry>[], workers = workersOn(path)): PoolStatAnswer => ({
  ...poolThroughput(basename(path), path, stat, window, workers),
  workers,
  backlog: stat.size,
  counts: stat.counts,
  policy: {
    agingSeconds: stat.agingSeconds,
    agingBoost: stat.agingBoost,
    agingMax: stat.agingMax,
    leaseMs: stat.leaseMs,
    maxAttempts: stat.maxAttempts,
    backoffMs: stat.backoffMs,
    backoffMaxMs: stat.backoffMaxMs,
    sweepIntervalMs: stat.sweepIntervalMs,
  },
});

/** Every pool under the pools directory, with its throughput. Anything there that is not a pool is skipped. */
export const statAllPools = async (cmd: Command): Promise<PoolStatAnswer[]> => {
  const poolsPath = cmd.env.POOLS_PATH || POOLS_PATH;
  const [window, entries] = await Promise.all([
    readPoolsSeries(cmd),
    cmd.sys.vfs.children(cmd.access, poolsPath).catch(() => []),
  ]);

  const pools = await Promise.all(entries.map(async (entry) => {
    const path = join(poolsPath, entry.name);
    try {
      return answer(path, await readPoolStat(cmd.sys.vfs, cmd.access, path), window);
    } catch {
      return undefined; // not a pool, or unreadable
    }
  }));

  return pools.filter((pool): pool is PoolStatAnswer => pool !== undefined);
};

const writePools = async (cmd: Command, pools: PoolStatAnswer[]): Promise<void> => {
  for (const pool of pools) {
    const rateText = pool.perHour !== undefined ? `  ${pool.perHour}/h` : '';
    const label = pool.role === 'intake' ? `${pool.name} (intake)` : pool.name;
    await cmd.writeLn(`pool    ${label.padEnd(18)} ${pool.ready + pool.claimed} left${rateText}${fmtEta(pool.etaMs)}`);

    for (const kind of pool.kinds ?? []) {
      if (kind.ready + kind.claimed === 0 && kind.perHour === undefined) continue;
      const kindRate = kind.perHour !== undefined ? `  in ${kind.inPerHour ?? 0}/h out ${kind.perHour}/h` : '';
      // Said in place of the ETA: an estimate for work nothing will ever claim is the number
      // that misleads, so it is the one to replace.
      const unservableText = kind.unservableSince !== undefined ? `  NO WORKER offers this kind (since ${new Date(kind.unservableSince).toISOString()})` : fmtEta(kind.etaMs);
      const waitText = kind.oldestReadyAt !== undefined ? `  oldest waiting ${fmtAge(Date.now() - kind.oldestReadyAt)}` : '';
      const restText = kind.restingUntil === undefined ? '' : `  resting, next try in ${fmtAge(kind.restingUntil - Date.now())}`;
      await cmd.writeLn(`          ${kind.kind.padEnd(16)} ${kind.ready + kind.claimed} left${kindRate}${unservableText}${waitText}${restText}`);
    }

    for (const worker of pool.workers) {
      const on = worker.currentKind ? `on ${worker.currentKind}` : 'idle';
      const holding = worker.accumulatingFor ? `  holding capacity for ${worker.accumulatingFor}` : '';
      await cmd.writeLn(`          worker ${on}  offers ${worker.kinds.join(', ')}${holding}`);
    }
  }
};

export const poolStat = async (cmd: Command): CmdReturn => {
  const path = cmd.args[0];

  if (!path) {
    const pools = await statAllPools(cmd);
    if (cmd.json) {
      await cmd.writeJSON(pools satisfies PoolStatAnswer[]);
      return 0;
    }
    if (pools.length === 0) await cmd.writeLn('no pools');
    await writePools(cmd, pools);
    return 0;
  }

  try {
    const [stat, window] = await Promise.all([
      cmd.sys.vfs.stat(cmd.access, path) as Promise<PoolStat>,
      readPoolsSeries(cmd),
    ]);

    // writeYAML degrades to JSON in JSON mode, so one call covers both.
    await cmd.writeYAML(answer(path, stat, window) satisfies PoolStatAnswer);

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`pool-stat: ${message}\n`);
    return 1;
  }
};

poolStat.spec = {
  name: 'pool-stat',
  effect: 'read' as const,
  description: 'Show a pool backlog, job counts, policy and throughput per job kind; every pool without a path',
  args: [
    { name: 'path', type: 'path' as const, description: 'Pool node path (default: every pool)', optional: true },
  ],
};
