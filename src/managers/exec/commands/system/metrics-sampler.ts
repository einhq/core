/**
 * metrics-sampler — the only thing that touches the host, on a clock.
 *
 * Everything the system dashboard charts is written here and read from a log,
 * rather than probed per request. That is not caching for its own sake: a
 * dashboard open in three browsers would otherwise spawn three `nvidia-smi`
 * processes every few seconds, and CPU utilization cannot be answered by a
 * single request at all — it is a delta between two observations, so somebody
 * has to be keeping the series.
 *
 * Each series has its own cadence. The loop ticks at the shortest one and starts
 * the series that are due, so a 15-minute census costs nothing on the 15-second
 * ticks in between. A series runs on its own and is not waited on: the census
 * scans the attrs table and takes minutes on a large archive, and awaited in line
 * it would hold `pools`, and the unservable-kind alarm fed from it, back for as
 * long.
 *
 * Long-running, so exempt from JSON output — like pipeline-engine and
 * relations-guard, it owns its stdout as a service log.
 */

import { PIPELINES_PATH, POOLS_PATH } from '../../../../lib/paths.ts';
import { join } from '@std/path';
import { toText } from '@std/streams/to-text';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { type EntryPointCoverage, parsePipeline } from '../../../pipeline/mod.ts';
import { poolWorkerStates } from '../../../pipeline/pool-worker.ts';
import { unservableKinds } from '../../../pipeline/unservable.ts';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { deferred } from '../../../../lib/async/deferred.ts';
import { type Kind, kindConditions, NOT_DERIVED } from '../../../../lib/kinds/mod.ts';
import { createLogger } from '../../../logger/mod.ts';
import type { PrunedCompletedAttrs } from '../pipeline/pipeline-prune.ts';
import {
  type DiskEntry,
  METRICS_PATH,
  METRICS_SERIES,
  type MetricsSeries,
  type MetricsSeriesName,
  type NodesEntry,
  type PipelinesEntry,
  type PoolCountsEntry,
  type PoolsEntry,
  sampleCpu,
  sampleDisk,
  sampleMemory,
  sampleRuntime,
  seriesPath,
  startLoopLagProbe,
  stopLoopLagProbe,
  TICK_MS,
  type TierRoots,
} from '../../../../lib/metrics/mod.ts';
import { type AttrCondition, attrRefOf } from '../../../../vfs/query.ts';
import type { NodeVFS } from '../../../../vfs/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../../../vfs/types/directory.ts';
import { NODE_TYPE_LOG } from '../../../../vfs/types/log.ts';
import type { LogHandle } from '../../../../registries/log/log-handle.ts';
import type { PoolStat } from '../../../../registries/pool/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

const logger = createLogger('metrics-sampler');

/**
 * Tier roots, as boot publishes them into /etc/layout: a service shell inherits
 * nothing from this process. `tmp` is not a storage tier, but it is a directory
 * that fills up and takes the instance down with it, so it is measured
 * alongside them.
 */
const tierRoots = (cmd: Command): TierRoots =>
  [
    { tier: 'disk' as const, path: cmd.env.EIN_FILE_ROOT_PATH ?? '' },
    { tier: 'volatile' as const, path: cmd.env.EIN_VOLATILE_FILE_ROOT_PATH ?? '' },
    { tier: 'tmp' as const, path: cmd.env.EIN_FILE_TMP_PATH ?? '' },
  ].filter((root, index, all) =>
    // The volatile tier falls back to the disk root when unset, and df would
    // then report the same filesystem twice under two tier names.
    root.path !== '' && all.findIndex((other) => other.path === root.path) === index
  );

/** Job counts for every pool, from the registry's own GROUP BY. */
const samplePools = async (cmd: Command): Promise<PoolsEntry | undefined> => {
  const poolsPath = cmd.env.POOLS_PATH || POOLS_PATH;

  let entries;
  try {
    entries = await cmd.sys.vfs.children(ADMIN_ACCESS, poolsPath);
  } catch {
    unservableKinds.observe(poolsPath, {}, poolWorkerStates());
    return undefined;
  }

  const out: PoolsEntry = {};
  for (const entry of entries) {
    try {
      const stat = await cmd.sys.vfs.stat(ADMIN_ACCESS, join(poolsPath, entry.name)) as unknown as PoolStat;

      const byKind: Record<string, PoolCountsEntry> = {};
      for (const [kind, counts] of Object.entries(stat.byKind ?? {})) {
        byKind[kind] = {
          ready: counts.ready ?? 0,
          claimed: counts.claimed ?? 0,
          done: counts.done ?? 0,
          failed: counts.failed ?? 0,
        };
      }

      out[entry.name] = {
        ready: stat.size ?? 0,
        claimed: stat.counts?.claimed ?? 0,
        done: stat.counts?.done ?? 0,
        failed: stat.counts?.failed ?? 0,
        byKind,
      };
    } catch {
      // Not a pool, or unreadable.
    }
  }

  // The per-kind counts are in hand, so this is where "ready jobs no worker will ever claim"
  // is cheapest to check. The alarm lives in the tracker, not the series: it is a process fact
  // about workers, and the sampler stores counters.
  unservableKinds.observe(poolsPath, out, poolWorkerStates());

  return Object.keys(out).length > 0 ? out : undefined;
};

/** The entry-point pipeline, and how it says to measure its coverage. */
type EntryPoint = { name: string; coverage?: EntryPointCoverage };

/**
 * Which pipeline means "this file has been taken in", and how to measure it.
 *
 * Read from the definitions rather than configured in core: the module that
 * owns the crawl declares `options.entryPoint`, and core never has to know a
 * media pipeline by name. Sorted so several claimants produce a stable answer
 * instead of whichever the directory listing happened to yield first.
 */
const entryPipeline = async (cmd: Command): Promise<EntryPoint | undefined> => {
  const defsPath = join(cmd.env.PIPELINES_PATH || PIPELINES_PATH, 'definitions');

  let entries;
  try {
    entries = await cmd.sys.vfs.children(ADMIN_ACCESS, defsPath);
  } catch {
    return undefined;
  }

  const claimants: EntryPoint[] = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const handle = await cmd.sys.vfs.open(ADMIN_ACCESS, join(defsPath, entry.name), { mode: 'r' });
      let yaml: string;
      try {
        yaml = await toText(handle.readable);
      } finally {
        await handle.close();
      }
      const def = parsePipeline(yaml);
      const declared = def.options?.entryPoint;
      if (!declared) continue;
      claimants.push({ name: def.name, coverage: declared === true ? undefined : declared });
    } catch {
      // An unparseable or unreadable definition claims nothing.
    }
  }

  if (claimants.length > 1) {
    logger.warn('several pipelines claim to be the entry point', { claimants: claimants.map((entry) => entry.name) });
  }

  return claimants[0];
};

/**
 * Completed instances per pipeline, counting the ones already pruned away.
 *
 * The live row count is not a counter on its own: `pipeline prune` keeps only
 * the newest `--keep` completed instances of each pipeline, so it saturates at
 * the cap. The pruner banks what it removed on the instance directory and it is
 * added back here, so the figure is a lifetime total and `rate()` does not reset
 * on every prune cycle.
 */
const samplePipelines = async (cmd: Command): Promise<PipelinesEntry | undefined> => {
  try {
    const buckets = await cmd.sys.vfs.aggregate(ADMIN_ACCESS, {
      where: [
        { ref: 'pipelineName', op: 'exists' },
        { ref: 'status', op: 'eq', value: 'completed' },
      ],
      group: [{ ref: 'pipelineName' }],
    });

    const completed: Record<string, number> = {};
    for (const bucket of buckets) completed[bucket.key[0]] = bucket.count;

    const instancesPath = join(cmd.env.PIPELINES_PATH || PIPELINES_PATH, 'instances');
    let pruned: Awaited<ReturnType<typeof cmd.sys.vfs.children<PrunedCompletedAttrs>>> = [];
    try {
      pruned = await cmd.sys.vfs.children<PrunedCompletedAttrs>(ADMIN_ACCESS, instancesPath);
    } catch {
      // No instances directory yet — the live counts stand on their own.
    }
    for (const entry of pruned) {
      const banked = entry.node.attrs?.prunedCompleted;
      if (typeof banked === 'number' && banked > 0) {
        completed[entry.name] = (completed[entry.name] ?? 0) + banked;
      }
    }

    // Recorded alongside the counts so the reader needs no configuration and
    // no knowledge of which module is installed.
    return { completed, entryPoint: (await entryPipeline(cmd))?.name };
  } catch {
    return undefined;
  }
};

/**
 * How many files of the declared kinds exist, as the coverage denominator: those carrying the
 * `exempt` attr, which the entry point takes in without a marker, left out.
 *
 * One aggregate per kind: the condition list is AND-only, so kinds cannot be
 * OR-ed into a single grouped query — the same reason `facets` counts
 * them in a loop. Only kinds that are a mimetype prefix can be pushed down at
 * all, so a kind that is not (a person, an album) contributes nothing and is
 * skipped rather than silently counting every file of that node type.
 */
export const sampleCandidates = async (vfs: Pick<NodeVFS, 'aggregate'>, coverage: Pick<EntryPointCoverage, 'kinds' | 'exempt'>): Promise<number> => {
  const exempt: AttrCondition[] = coverage.exempt ? [{ ref: attrRefOf(coverage.exempt), op: 'missing' }] : [];
  let total = 0;
  for (const kind of coverage.kinds) {
    const conditions = kindConditions([kind]);
    if (conditions.length === 0) continue;

    const buckets = await vfs.aggregate(ADMIN_ACCESS, {
      types: ['file'],
      where: [NOT_DERIVED, ...conditions, ...exempt],
      group: [{ ref: 'mimetype' }],
    });
    total += buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  }
  return total;
};

/**
 * The library by the month each file joined it, and the bytes it brought.
 *
 * The same candidate set as the coverage denominator, grouped on `birthtime`
 * and summing `size`. Derivatives are excluded for the reason they always are:
 * a thumbnail is created the day the crawl reaches it, so counting them turns
 * two decades of history into one spike in the current month. The monthly
 * result is also rolled up into annual bars.
 *
 * One aggregate per kind, again because the condition list is AND-only.
 */
const sampleGrowth = async (
  cmd: Command,
  kinds: Kind[],
): Promise<Pick<NodesEntry, 'growth' | 'growthMonths'>> => {
  const byMonth = new Map<string, { count: number; bytes: number }>();

  for (const kind of kinds) {
    const conditions = kindConditions([kind]);
    if (conditions.length === 0) continue;

    const buckets = await cmd.sys.vfs.aggregate(ADMIN_ACCESS, {
      types: ['file'],
      where: [NOT_DERIVED, ...conditions],
      group: [{ column: 'birthtime', truncate: 'month' }],
      sum: 'size',
    });

    for (const bucket of buckets) {
      const month = byMonth.get(bucket.key[0]) ?? { count: 0, bytes: 0 };
      month.count += bucket.count;
      month.bytes += bucket.sum ?? 0;
      byMonth.set(bucket.key[0], month);
    }
  }

  if (byMonth.size === 0) return {};

  const keys = [...byMonth.keys()].sort();
  const first = new Date(`${keys[0]}-01T00:00:00Z`);
  const last = new Date(`${keys[keys.length - 1]}-01T00:00:00Z`);
  const growthMonths: NonNullable<NodesEntry['growthMonths']> = [];
  for (const cursor = first; cursor <= last; cursor.setUTCMonth(cursor.getUTCMonth() + 1)) {
    const month = cursor.toISOString().slice(0, 7);
    growthMonths.push({ month, ...(byMonth.get(month) ?? { count: 0, bytes: 0 }) });
  }

  const byYear = new Map<string, { count: number; bytes: number }>();
  for (const point of growthMonths) {
    const year = point.month.slice(0, 4);
    const totals = byYear.get(year) ?? { count: 0, bytes: 0 };
    totals.count += point.count;
    totals.bytes += point.bytes;
    byYear.set(year, totals);
  }

  return {
    growth: [...byYear.entries()].map(([year, totals]) => ({ year, ...totals })),
    growthMonths,
  };
};

/**
 * The whole tree counted by type, how many file nodes are derivatives, and how
 * far the entry-point pipeline has got.
 *
 * The census is a GROUP BY on an indexed column; the other two are not indexed
 * at all and scan the attrs table. All three belong here rather than in the
 * command that renders them — this runs on a quarter-hour, the dashboard polls
 * every ten seconds, and the difference is what keeps an unindexed scan off the
 * request path.
 *
 * Coverage is a node census question, which is why it lives here and not with
 * the pipeline counts: its numerator is a node type in `byType` and its
 * denominator is a count of files, so both come from the same pass and neither
 * has anything to do with how many instances ran.
 */
const sampleNodes = async (cmd: Command): Promise<NodesEntry | undefined> => {
  try {
    const buckets = await cmd.sys.vfs.aggregate(ADMIN_ACCESS, { group: [{ column: 'type' }] });
    if (buckets.length === 0) return undefined;

    const byType: Record<string, number> = {};
    for (const bucket of buckets) byType[bucket.key[0]] = bucket.count;

    let derivedFiles: number | undefined;
    try {
      const derived = await cmd.sys.vfs.aggregate(ADMIN_ACCESS, {
        where: [{ ref: 'sourceId', op: 'exists' }],
        group: [{ column: 'type' }],
      });
      derivedFiles = derived.find((bucket) => bucket.key[0] === 'file')?.count ?? 0;
    } catch {
      // The census is still worth having without it.
    }

    let coverage: NodesEntry['coverage'];
    let growth: NodesEntry['growth'];
    let growthMonths: NodesEntry['growthMonths'];
    try {
      const entry = await entryPipeline(cmd);
      if (entry?.coverage) {
        coverage = {
          pipeline: entry.name,
          marker: entry.coverage.marker,
          kinds: entry.coverage.kinds,
          covered: byType[entry.coverage.marker] ?? 0,
          candidates: await sampleCandidates(cmd.sys.vfs, entry.coverage),
        };
        ({ growth, growthMonths } = await sampleGrowth(cmd, entry.coverage.kinds));
      }
    } catch {
      // No entry point, or it declares no coverage — the crawl card hides.
    }

    return { byType, derivedFiles, coverage, growth, growthMonths };
  } catch {
    return undefined;
  }
};

const sample = async (cmd: Command, name: MetricsSeriesName): Promise<unknown | undefined> => {
  switch (name) {
    case 'cpu':
      return await sampleCpu();
    case 'memory':
      return await sampleMemory();
    case 'runtime':
      return sampleRuntime();
    case 'pools':
      return await samplePools(cmd);
    case 'pipelines':
      return await samplePipelines(cmd);
    case 'disk': {
      const disks: DiskEntry = await sampleDisk(tierRoots(cmd));
      return disks.length > 0 ? disks : undefined;
    }
    case 'nodes':
      return await sampleNodes(cmd);
  }
};

/**
 * Create one series' log node if it is missing, the same way the pipeline
 * engine creates the pools its definitions name. The series table is then the
 * only declaration of these logs — nothing in the boot scripts has to agree
 * with it.
 *
 * Done lazily, per series, on the tick that first has something to write —
 * *not* as one pass at startup. Creating a log node is DDL (a hypertable plus
 * its retention policy), and on a loaded instance that queues behind whatever
 * the engine is doing, for minutes. A startup pass would make that one slow
 * create block every other series from sampling; this way each series stands
 * alone, and a create that fails is retried on the next tick.
 *
 * It also means a probe with no source never creates a node at all, rather than
 * an empty one.
 */
const ensureSeries = async (cmd: Command, series: MetricsSeries): Promise<void> => {
  const vfs = cmd.sys.vfs;

  try {
    await vfs.get(ADMIN_ACCESS, METRICS_PATH);
  } catch {
    const parent = METRICS_PATH.slice(0, METRICS_PATH.lastIndexOf('/')) || '/';
    const name = METRICS_PATH.slice(METRICS_PATH.lastIndexOf('/') + 1);
    try {
      await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, parent, name);
    } catch {
      // Raced with another tick, or it appeared between the get and the create.
    }
  }

  const path = seriesPath(series.name);
  try {
    await vfs.get(ADMIN_ACCESS, path);
    return;
  } catch {
    // Missing — create it below.
  }

  // No routing keys: these are written directly and must not pick up relay
  // traffic bound for /logs/system.
  await vfs.create(ADMIN_ACCESS, NODE_TYPE_LOG, METRICS_PATH, series.name, {
    attrs: { retention: series.retention, description: series.description },
  });
  logger.info('created metrics series', { path, retention: series.retention });
};

const append = async (cmd: Command, name: string, value: unknown): Promise<void> => {
  const handle = await cmd.sys.vfs.open(ADMIN_ACCESS, seriesPath(name), { mode: 'a' }) as unknown as LogHandle;
  try {
    await handle.appendAt(value);
  } finally {
    await handle.close();
  }
};

/** Core's series, each with how to read it. A module keeps its own series in a service of its own. */
const allSeries = (cmd: Command): (MetricsSeries & { read: () => Promise<unknown | undefined> })[] =>
  METRICS_SERIES.map((series) => ({ ...series, read: () => sample(cmd, series.name as MetricsSeriesName) }));

/**
 * Start every series that is due and not still running from an earlier tick.
 *
 * Does not wait for them. A slow series (the node census, minutes on a large archive) holds only
 * its own next reading back: it is skipped while in flight rather than started a second time,
 * and every other series keeps its cadence. Its due time is set when it starts, so a reading
 * that overran its interval is taken again on the next tick after it finishes.
 */
export const startDueSeries = (
  series: { name: string; intervalMs: number }[],
  now: number,
  due: Map<string, number>,
  inFlight: Map<string, Promise<void>>,
  run: (name: string) => Promise<void>,
): void => {
  for (const { name, intervalMs } of series) {
    if (inFlight.has(name)) continue;
    if (now < (due.get(name) ?? 0)) continue;
    due.set(name, now + intervalMs);

    const reading = run(name).finally(() => inFlight.delete(name));
    inFlight.set(name, reading);
  }
};

export const metricsSampler = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { string: ['interval'] });
  const tickMs = flags.interval ? Math.max(1000, Number(flags.interval) * 1000) : TICK_MS;

  const due = new Map<string, number>();
  const inFlight = new Map<string, Promise<void>>();
  const ensured = new Set<string>();

  // Started here rather than on the first sample so the first window is a full
  // interval; `sampleRuntime` would otherwise drain an empty one and skip the
  // first row.
  startLoopLagProbe();

  await cmd.write(`metrics-sampler running (tick ${tickMs / 1000}s, ${allSeries(cmd).length} series)\n`);

  const stopped = deferred<void>();
  cmd.onInterrupt(() => stopped.resolve());

  while (!stopped.isFinished()) {
    const series = allSeries(cmd);
    const byName = new Map(series.map((entry) => [entry.name, entry]));

    startDueSeries(series, Date.now(), due, inFlight, async (name) => {
      const entry = byName.get(name)!;
      try {
        const value = await entry.read();
        // A probe with no source appends nothing. A run of null rows would
        // read as "the GPU was idle" rather than "there is no GPU".
        if (value === undefined) return;

        if (!ensured.has(name)) {
          await ensureSeries(cmd, entry);
          ensured.add(name);
        }

        await append(cmd, name, value);
      } catch (error) {
        logger.warn('sample failed', { series: name, error: (error as Error).message });
      }
    });

    // Wake on whichever comes first: the next tick or a shutdown. The timer is
    // cleared either way, so a stop does not hold the runtime open for one more
    // interval.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([stopped, new Promise((resolve) => timer = setTimeout(resolve, tickMs))]);
    clearTimeout(timer);
  }

  // A reading still running would append after the service reported itself stopped.
  await Promise.allSettled([...inFlight.values()]);

  cmd.onInterrupt(null);
  stopLoopLagProbe();
  await cmd.write('metrics-sampler stopped\n');
  return 0;
};

metricsSampler.spec = {
  name: 'metrics-sampler',
  admin: true,
  effect: 'write' as const,
  daemon: true,
  json: false,
  description: 'Sample host, storage and workload metrics into /logs/metrics (long-running)',
  args: [],
  flags: [
    { name: 'interval', type: 'string' as const, description: 'Seconds between ticks (default: shortest series cadence)' },
  ],
};
