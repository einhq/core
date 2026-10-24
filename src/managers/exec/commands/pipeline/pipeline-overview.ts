/**
 * pipeline-overview — the whole workload in one round trip.
 *
 * Everything here is an aggregate or a bounded query, never a directory walk,
 * so a dashboard can poll it. Counts come from `vfs.aggregate`, a single
 * GROUP BY.
 *
 * Two invariants this relies on:
 *
 *  - `pipelineName` and `stepName` are exact, non-overlapping discriminators.
 *    Instance nodes carry the first, step nodes the second, and nothing else in
 *    the tree carries `status` at all.
 *  - `completedAt` is epoch-ms and therefore uniformly 13 digits, so the text
 *    ordering `vfs.query` uses matches numeric ordering, and a prefix of 7
 *    digits buckets it at 10^6 ms (~16.7 min). Holds until the year 2286.
 *
 * Counts come from `vfs.aggregate`, which is **not** access-filtered (same
 * caveat as facets) while the `active` list is — for a non-admin the two
 * can disagree. This sizes a dashboard; it is not a data listing.
 */

import { QUEUES_PATH } from '../../../../lib/paths.ts';
import { join } from '@std/path';
import { instancesRoot } from './lib.ts';
import type { PrunedCompletedAttrs } from './pipeline-prune.ts';
import type { AggregateBucket } from '../../../../vfs/query.ts';
import type { QueueStat } from '../../../../registries/queue/types.ts';
import type { PipelineInstanceAttrs, PipelineStepAttrs } from '../../../pipeline/types.ts';
import { eta, type NodesEntry, type PipelinesEntry, rate, within } from '../../../../lib/metrics/mod.ts';
import type { CrawlCoverage } from '../../../../lib/api/pipeline.ts';
import { HOUR, RATE_WINDOW_MS, readSeries } from '../system/lib.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { INSTANCE_STATUSES, type InstanceStatus, type PipelineOverview, type PipelineRow } from '../../../../lib/api/pipeline.ts';

/** Step statuses that mean "not finished" — the live work. */
const UNFINISHED_STEPS = ['pending', 'queued', 'waiting', 'running'];

/** How many *executing* instances the activity list carries. */
const ACTIVE_LIMIT = 50;

/** How many running steps the quiet check reads; more than every pool and the engine run at once. */
const RUNNING_STEPS_LIMIT = 500;

/** How long a running step may go without output before it is listed as quiet; CFG_PIPELINE_STEP_QUIET_MS. */
const DEFAULT_QUIET_MS = 30 * 60 * 1000;

/** Bucket width for the completions series: 10^(13-7) ms. */
const BUCKET_DIGITS = 7;
const BUCKET_MS = 10 ** (13 - BUCKET_DIGITS);
const SERIES_WINDOW_MS = 24 * 60 * 60 * 1000;

const MB = 1024 * 1024;

/** Coarse age for the in-flight line — a held entry is either seconds old or a problem. */
const humanizeDuration = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
};

const toMap = (buckets: AggregateBucket[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const bucket of buckets) out[bucket.key[0]] = bucket.count;
  return out;
};

/**
 * Instances each pipeline finished per hour over the last hour.
 *
 * Not the same thing as the intake pool's rate for that pipeline, which is how fast triggers
 * become *instances*, and is uniform across pipelines by construction.
 *
 * `pipelines.completed` is cumulative across pruning — the sampler adds back what the pruner
 * removed — so differencing it is meaningful where counting live instance nodes is not.
 */
const readCompletionRates = async (cmd: Command): Promise<Map<string, number | undefined>> => {
  // 1min cadence -> ~1.5h, matched to the rate window.
  const samples = await readSeries<PipelinesEntry>(cmd, 'pipelines', 90);
  const window = within(samples, RATE_WINDOW_MS);
  const rates = new Map<string, number | undefined>();

  for (const name of Object.keys(samples[samples.length - 1]?.value.completed ?? {})) {
    const perMs = rate(window, (entry) => entry.completed?.[name]);
    rates.set(name, perMs === undefined ? undefined : Math.round(perMs * HOUR));
  }

  return rates;
};

/**
 * How much of the library the entry-point pipeline has taken in, from the sampler's `nodes`
 * series. No claimant, or a claimant that does not say how to measure itself, means none.
 *
 * Both sides are node counts, not instances: pipeline-pruner caps completed instances, while
 * marker nodes are never pruned, so this counter only grows.
 */
const readCoverage = async (cmd: Command): Promise<CrawlCoverage | undefined> => {
  // 15min cadence; the rate wants the same hour every other throughput here is measured over.
  const samples = await readSeries<NodesEntry>(cmd, 'nodes', 8);
  const coverage = samples[samples.length - 1]?.value.coverage;
  if (!coverage) return undefined;

  const perMs = rate(within(samples, RATE_WINDOW_MS), (entry) => entry.coverage?.covered);
  const remaining = Math.max(0, coverage.candidates - coverage.covered);

  return {
    pipeline: coverage.pipeline,
    kinds: coverage.kinds,
    candidates: coverage.candidates,
    covered: coverage.covered,
    remaining,
    perHour: perMs === undefined ? undefined : Math.round(perMs * HOUR),
    etaMs: eta(remaining, perMs),
  };
};

/** The workload as `pipeline-overview` answers it. */
export const readPipelineOverview = async (cmd: Command): Promise<PipelineOverview> => {
  const vfs = cmd.sys.vfs;
  const instancesPath = instancesRoot(cmd);
  const queuesPath = cmd.env.QUEUES_PATH || QUEUES_PATH;

  // ---- Instance status matrix -------------------------------------------
  const rows = new Map<string, PipelineRow>();
  const byStatus = { running: 0, queued: 0, completed: 0, failed: 0, cancelled: 0 } as Record<InstanceStatus, number>;

  const instanceBuckets = await vfs.aggregate(cmd.access, {
    where: [
      { ref: 'pipelineName', op: 'exists' },
      { ref: 'status', op: 'in', value: [...INSTANCE_STATUSES] },
    ],
    group: [{ ref: 'pipelineName' }, { ref: 'status' }],
  });

  for (const bucket of instanceBuckets) {
    const [pipeline, statusValue] = bucket.key;
    const status = statusValue as InstanceStatus;
    let row = rows.get(pipeline);
    if (!row) {
      row = { pipeline, total: 0, running: 0, queued: 0, completed: 0, failed: 0, cancelled: 0 };
      rows.set(pipeline, row);
    }
    row[status] = bucket.count;
    row.total += bucket.count;
    byStatus[status] += bucket.count;
  }

  // Instances the pruner has already deleted still happened. Without adding them
  // back, `completed` is a count of *surviving* rows and so pins at the retention
  // cap — every pipeline on a busy instance reads exactly `--keep`, and "all
  // time" becomes a restatement of the pruner's configuration.
  try {
    for (const entry of await vfs.children<PrunedCompletedAttrs>(cmd.access, instancesPath)) {
      const banked = entry.node.attrs?.prunedCompleted;
      if (typeof banked !== 'number' || banked <= 0) continue;

      let row = rows.get(entry.name);
      if (!row) {
        row = { pipeline: entry.name, total: 0, running: 0, queued: 0, completed: 0, failed: 0, cancelled: 0 };
        rows.set(entry.name, row);
      }
      row.completed += banked;
      row.total += banked;
      byStatus.completed += banked;
    }
  } catch { /* no instances dir */ }

  for (const [pipeline, perHour] of await readCompletionRates(cmd)) {
    const row = rows.get(pipeline);
    if (row && perHour !== undefined) row.completedPerHour = perHour;
  }

  const byPipeline = [...rows.values()].sort((a, b) => a.pipeline < b.pipeline ? -1 : 1);
  const total = byPipeline.reduce((sum, row) => sum + row.total, 0);

  // ---- Unfinished step counts -------------------------------------------
  const stepWhere = [
    { ref: 'stepName', op: 'exists' as const },
    { ref: 'status', op: 'in' as const, value: UNFINISHED_STEPS },
  ];

  const stepsByStatus = toMap(await vfs.aggregate(cmd.access, { where: stepWhere, group: [{ ref: 'status' }] }));

  // ---- Queues ------------------------------------------------------------
  // Depth is a COUNT on the queue's deliveries, not a walk. Claimable and
  // in-flight are separate numbers on purpose: summed into one, a queue reports
  // the same depth whether it is backed up or whether its consumers are simply
  // holding entries, and a stranded lock is invisible.
  const queues: PipelineOverview['queues'] = [];
  try {
    for (const entry of await vfs.children(cmd.access, queuesPath)) {
      const path = join(queuesPath, entry.name);
      try {
        const stat = await vfs.stat(cmd.access, path) as unknown as QueueStat;
        queues.push({
          name: entry.name,
          path,
          size: stat.size ?? 0,
          inFlight: stat.inFlight ?? 0,
          oldestInFlightMs: stat.oldestInFlightMs ?? 0,
          deadLettered: stat.deadLettered ?? 0,
          routingKeys: stat.routingKeys ?? [],
        });
      } catch { /* not a queue, or unreadable */ }
    }
  } catch { /* no queues dir */ }

  // ---- What is actually executing ---------------------------------------
  // Bounded and newest-first. orderBy excludes rows without the attr, which is
  // fine: a running instance always has startedAt.
  //
  // 'running' means executing now; an instance whose steps wait in a pool is 'queued'.
  const active: PipelineOverview['active'] = [];
  const prefix = instancesPath + '/';
  const activeRows = await vfs.query(cmd.access, {
    where: [
      { ref: 'pipelineName', op: 'exists' },
      { ref: 'status', op: 'eq', value: 'running' },
    ],
    orderBy: { ref: 'startedAt', dir: 'desc' },
    limit: ACTIVE_LIMIT,
  });

  for (const row of activeRows) {
    if (!row.absPath.startsWith(prefix)) continue;
    const parts = row.absPath.slice(prefix.length).split('/').filter(Boolean);
    if (parts.length !== 2) continue;
    const attrs = row.node.attrs as PipelineInstanceAttrs;
    active.push({
      pipeline: parts[0],
      id: parts[1],
      path: row.absPath,
      triggerPath: attrs.triggerPath || '',
      startedAt: attrs.startedAt,
      executingSince: attrs.executingSince ?? attrs.startedAt,
    });
  }

  // ---- Running steps that have gone quiet --------------------------------
  // No step is stopped for taking long (ein/core#358). One that has written nothing
  // for a long while is listed instead, for a person to look at; a slow step that still
  // reports, such as a long encode writing its progress, is not.
  const quietMs = Number(cmd.env.CFG_PIPELINE_STEP_QUIET_MS) || DEFAULT_QUIET_MS;
  const now = Date.now();
  const quiet: PipelineOverview['quiet'] = [];
  const runningSteps = await vfs.query(cmd.access, {
    where: [
      { ref: 'stepName', op: 'exists' },
      { ref: 'status', op: 'eq', value: 'running' },
    ],
    orderBy: { ref: 'startedAt', dir: 'asc' },
    limit: RUNNING_STEPS_LIMIT,
  });
  for (const row of runningSteps) {
    if (!row.absPath.startsWith(prefix)) continue;
    const parts = row.absPath.slice(prefix.length).split('/').filter(Boolean);
    if (parts.length !== 4 || parts[2] !== 'steps') continue;
    const attrs = row.node.attrs as PipelineStepAttrs;
    if (attrs.startedAt === undefined) continue;
    const lastSign = Math.max(attrs.startedAt, attrs.outputAt ?? 0);
    if (now - lastSign < quietMs) continue;
    quiet.push({
      pipeline: parts[0],
      id: parts[1],
      step: parts[3],
      path: row.absPath,
      startedAt: attrs.startedAt,
      ...(attrs.outputAt !== undefined ? { outputAt: attrs.outputAt } : {}),
    });
  }

  // ---- Completions over time --------------------------------------------
  const since = Date.now() - SERIES_WINDOW_MS;
  const seriesBuckets = await vfs.aggregate(cmd.access, {
    where: [
      { ref: 'pipelineName', op: 'exists' },
      { ref: 'completedAt', op: 'gte', value: String(since) },
    ],
    group: [{ ref: 'completedAt', prefixLength: BUCKET_DIGITS }],
  });

  const completions = seriesBuckets
    .filter((bucket) => /^\d+$/.test(bucket.key[0]))
    .map((bucket) => ({ at: Number(bucket.key[0]) * BUCKET_MS, count: bucket.count }))
    .sort((a, b) => a.at - b.at);

  const coverage = await readCoverage(cmd);

  const mem = Deno.memoryUsage();
  return {
    instances: { total, byStatus, byPipeline },
    steps: { byStatus: stepsByStatus },
    queues,
    active,
    quiet,
    quietMs,
    completions,
    coverage,
    memory: {
      heapUsedMb: Math.round(mem.heapUsed / MB),
      heapTotalMb: Math.round(mem.heapTotal / MB),
      rssMb: Math.round(mem.rss / MB),
    },
  };
};

export const pipelineOverview = async (cmd: Command): CmdReturn => {
  const payload = await readPipelineOverview(cmd);
  const { instances: { total, byStatus, byPipeline }, steps: { byStatus: stepsByStatus }, queues, quiet, completions, coverage } = payload;

  if (cmd.json) {
    await cmd.writeJSON(payload);
    return 0;
  }

  await cmd.writeLn(
    `instances: ${total}  running ${byStatus.running}  queued ${byStatus.queued}  completed ${byStatus.completed}  failed ${byStatus.failed}  cancelled ${byStatus.cancelled}`,
  );
  for (const row of byPipeline) {
    await cmd.writeLn(
      `  ${row.pipeline.padEnd(20)} ${String(row.running).padStart(6)} running ${String(row.queued).padStart(6)} queued ${String(row.completed).padStart(7)} done ${
        String(row.failed).padStart(6)
      } failed`,
    );
  }

  const unfinished = Object.entries(stepsByStatus).map(([key, value]) => `${key} ${value}`).join('  ');
  await cmd.writeLn(`steps: ${unfinished || 'none unfinished'}`);
  for (const step of quiet) {
    const said = step.outputAt === undefined ? 'no output yet' : `last output ${humanizeDuration(Date.now() - step.outputAt)} ago`;
    await cmd.writeLn(`  quiet ${step.pipeline}/${step.id} ${step.step}: running ${humanizeDuration(Date.now() - step.startedAt)}, ${said}`);
  }

  for (const queue of queues) {
    // The age only shows up when something is held, and it is the number that
    // separates "consumers are busy" from "these are never coming back".
    const held = queue.inFlight > 0 ? `  in flight ${queue.inFlight} (oldest ${humanizeDuration(queue.oldestInFlightMs)})` : '';
    // Only when there are any: a zero here is the normal case and would just be
    // one more column to read past.
    const dead = queue.deadLettered > 0 ? `  dead ${queue.deadLettered}` : '';
    await cmd.writeLn(`  queue ${queue.name.padEnd(18)} depth ${String(queue.size).padStart(6)}${held}${dead}`);
  }

  if (coverage) {
    const rateText = coverage.perHour !== undefined ? `  ${coverage.perHour}/h` : '';
    const etaText = coverage.etaMs !== undefined ? `  eta ${humanizeDuration(coverage.etaMs)}` : '';
    await cmd.writeLn(
      `crawl: ${coverage.covered.toLocaleString()}/${coverage.candidates.toLocaleString()} ${coverage.kinds.join('+')} taken in by ${coverage.pipeline}${rateText}${etaText}`,
    );
  }

  const lastHour = completions.filter((bucket) => bucket.at >= Date.now() - 3600_000).reduce((sum, b) => sum + b.count, 0);
  await cmd.writeLn(`completed in the last hour: ${lastHour}`);
  await cmd.writeLn(
    `engine heap: ${payload.memory.heapUsedMb} / ${payload.memory.heapTotalMb} MB  (rss ${payload.memory.rssMb} MB)`,
  );

  return 0;
};

pipelineOverview.spec = {
  name: 'pipeline-overview',
  effect: 'read' as const,
  description: 'Pipeline workload summary: instance counts (running, failed, completed), queue depths, active instances, completion rate',
  args: [],
  flags: [],
};
