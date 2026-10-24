/**
 * What each metrics series stores, one type per log node.
 *
 * Every one of these is a *reading*, not a rate: cumulative counters where the
 * kernel or the registry keeps a counter, instantaneous values where it does
 * not. Rates are derived from two entries at read time (see `derive.ts`), which
 * is what lets the sampler stay stateless and survive a restart mid-series.
 */

import type { CpuSample, MemorySample } from './host.ts';
import type { DiskSample } from './disk.ts';
import type { RuntimeSample } from './runtime.ts';

export type CpuEntry = CpuSample;
export type MemoryEntry = MemorySample;
export type RuntimeEntry = RuntimeSample;

export type PoolCountsEntry = { ready: number; claimed: number; done: number; failed: number };

/**
 * Job counts by state, per pool name. `done` is cumulative.
 *
 * `byKind` carries the same numbers split by job kind, because a pool is
 * claimed by capability rather than by name and so holds work of very different
 * cost together. One rate over that mixture drifts with the mix instead of the
 * backlog, which is no basis for an estimate.
 */
export type PoolsEntry = Record<string, PoolCountsEntry & { byKind?: Record<string, PoolCountsEntry> }>;

/**
 * Cumulative completed instances per pipeline, and which of them is the crawl's
 * entry point.
 *
 * Cumulative *across pruning*: instance nodes are deleted down to a per-pipeline
 * cap on a schedule, so the live row count alone is not a counter — it saturates
 * at the cap and then reports the cap forever. The sampler adds back what the
 * pruner recorded it removed, which is what makes differencing this meaningful.
 *
 * The name rides along with the counts rather than being configured in the
 * reader, so the dashboard can report how far an import has got without core
 * knowing that a media module exists. A separate field and not a reserved key
 * in `completed` — a pipeline is free to be called anything.
 */
export type PipelinesEntry = {
  completed: Record<string, number>;
  /** Name of the pipeline whose completion means "this file has been taken in". */
  entryPoint?: string;
};

export type DiskEntry = DiskSample[];

/**
 * A census of the tree.
 *
 * `derivedFiles` rides along because it answers the same question from the same
 * scan: how many of those file nodes are thumbnails and transcodes rather than
 * originals. It belongs to a *sample* and not to the dashboard request that
 * displays it — it is a full pass over the attrs table with no index behind it,
 * which is fine every fifteen minutes and ruinous every ten seconds.
 */
export type NodesEntry = {
  byType: Record<string, number>;
  /** File nodes carrying `sourceId` — derivatives, and never candidates for indexing. */
  derivedFiles?: number;
  /**
   * How much of the library the entry-point pipeline has taken in, when one
   * declares how to measure itself (`options.entryPoint.kinds` / `.marker`).
   *
   * Both sides are node counts, which is the point: `covered` only ever grows,
   * so differencing it gives a real indexing rate, and `candidates` counts only
   * files of the declared content kinds rather than every non-derived file on
   * the instance, which would sweep in documents, session files and service
   * logs and put the finish line far too far away.
   */
  coverage?: {
    /** The entry-point pipeline this describes, for labelling. */
    pipeline: string;
    /** Node type counted as "this file is indexed". */
    marker: string;
    /** Content kinds the candidates were drawn from. */
    kinds: string[];
    covered: number;
    candidates: number;
  };
  /**
   * The library by the year each file entered it, with the bytes it brought.
   *
   * Keyed on `birthtime`, which an import preserves from the original files
   * rather than stamping with the import date — so this is a real history and
   * not a spike on the day of the crawl. Counts only the same non-derived files
   * of the declared content kinds
   * that coverage uses as its denominator: derivatives are created now and
   * would bury the history under the current year.
   */
  growth?: { year: string; count: number; bytes: number }[];
  /** Monthly additions used to draw the cumulative line over annual growth. */
  growthMonths?: { month: string; count: number; bytes: number }[];
};

export type { Sample } from './sample.ts';
