import type { DomainEvent } from './events.ts';

export type PipelineRow = {
  pipeline: string;
  total: number;
  /**
   * Instances finished per hour over the last hour, from the sampler's `pipelines` series —
   * cumulative across pruning, so its growth is meaningful where counting live instance
   * nodes is not. Absent until the sampler has samples a minute apart in the window.
   */
  completedPerHour?: number;
} & Record<InstanceStatus, number>;

export type PipelineOverview = {
  instances: {
    total: number;
    byStatus: Record<InstanceStatus, number>;
    byPipeline: PipelineRow[];
  };
  steps: {
    /** Unfinished steps by status — pending/waiting/running. */
    byStatus: Record<string, number>;
  };
  /**
   * Queues: every queue under the queues directory, the engine's own trigger inbox among them.
   * Delegated work is in the pools, which `pool stat` reports.
   */
  queues: {
    name: string;
    path: string;
    /** Claimable entries. In-flight ones are counted separately, not here. */
    size: number;
    inFlight: number;
    oldestInFlightMs: number;
    /**
     * Entries that used up their delivery attempts and will not be retried.
     * Non-zero means work was dropped on the floor — the one queue number that
     * always warrants a look.
     */
    deadLettered: number;
    routingKeys: string[];
  }[];
  /** Instances with a step executing right now — not merely live. */
  active: {
    pipeline: string;
    id: string;
    path: string;
    triggerPath: string;
    /** Creation, including however long the instance sat queued. */
    startedAt: number;
    /**
     * When the executing step started. Always present — it falls back to `startedAt` for an
     * instance that does not record it, because the UI subtracts it from the clock and an absent
     * value renders as NaN.
     */
    executingSince: number;
  }[];
  /**
   * Running steps that have written nothing for `quietMs` or longer, oldest first. They keep
   * running; the list is for a person to look at.
   */
  quiet: {
    pipeline: string;
    id: string;
    step: string;
    path: string;
    startedAt: number;
    /** When the step last wrote output; absent when it has written nothing yet. */
    outputAt?: number;
  }[];
  /** How long a running step goes without output before it is listed in `quiet`. */
  quietMs: number;
  /**
   * Instances completed over the last day, in ~16.7-minute buckets (`at` is the bucket's start),
   * from the sampler's `pipelines` series; empty until it has two samples.
   */
  completions: { at: number; count: number }[];
  /** Absent when no pipeline declares itself the entry point with a way to measure coverage. */
  coverage?: CrawlCoverage;
  /**
   * The engine process's own heap. Commands run in-process, so this is the
   * engine's memory, and `heapUsed` against `heapTotal` is what actually
   * matters — V8 rarely returns pages to the OS, so RSS overstates it badly.
   *
   * Here because the pipeline is what fills this heap: dispatched steps park as
   * live promises.
   */
  memory: { heapUsedMb: number; heapTotalMb: number; rssMb: number };
};

/**
 * How much of the library the entry-point pipeline has taken in.
 *
 * What counts as taken in, and how to measure it, are both declared by the pipeline itself
 * (`options.entryPoint`) and recorded by `metrics-sampler`, so core names no module's pipeline.
 * Counts nodes, never pipeline instances: instances are pruned to a cap, so a count of them stops
 * growing long before the library is taken in.
 */
export type CrawlCoverage = {
  pipeline: string;
  /** Content kinds counted, so a reader can name what was measured. */
  kinds: string[];
  /** Non-derived files of those kinds — the denominator. */
  candidates: number;
  /** Files carrying the pipeline's marker node — the numerator. */
  covered: number;
  remaining: number;
  perHour?: number;
  etaMs?: number;
};

/** Instance statuses, in the order the UI shows them. */
export const INSTANCE_STATUSES = ['running', 'queued', 'completed', 'failed', 'cancelled'] as const;

export type InstanceStatus = typeof INSTANCE_STATUSES[number];

/**
 * One trigger alternative as declared, guards included. Fact-triggered pipelines set `on`,
 * VFS-triggered ones `event` + `nodeType`; every other field is absent unless declared.
 */
export type PipelineTriggerSummary = {
  on?: string[];
  event?: string;
  nodeType?: string;
  match?: Record<string, string | string[]>;
  /** `match`'s keys and globs; the event is skipped when every key matches. */
  unless?: Record<string, string | string[]>;
  allowDerived?: boolean;
  skipIfExists?: string;
  skipIfAttr?: string;
  /** Shell script; exit 0 keeps the event. */
  filter?: string;
  /** Shell script; exit 0 drops the event. */
  skipIf?: string;
  vars?: Record<string, string>;
  priority?: number;
};

export type PipelineSummary = {
  name: string;
  description: string;
  /** Raw alternatives. Fact-triggered pipelines set only `on`. */
  triggers: { on?: string[]; event?: string; nodeType?: string }[];
  /**
   * The same alternatives with their guards, for explaining what a pipeline skips. When absent,
   * fall back to `triggers`.
   */
  triggerRules?: PipelineTriggerSummary[];
  /** Rendered form of the above — use this for display. */
  triggerLabel?: string;
  /** Step name to the pool kind it is delegated to. Absent entries are inline steps. */
  stepKinds?: Record<string, string>;
  steps: string[];
  options?: { maxAttempts?: number; priority?: number };
  error?: boolean;
};

export type PipelineInstance = {
  id: string;
  pipeline: string;
  status: string;
  triggerPath: string;
  startedAt: number;
  completedAt?: number;
};

export type PipelineStepStatus = {
  stepName: string;
  status: string;
  dependsOn?: string[];
  command: string;
  condition?: string;
  /** The pool a delegated step waits on or runs in, and the kind of work it was queued as. */
  pool?: string;
  kind?: string;
  /** Runs started so far, the failed ones included. */
  attempts?: number;
  maxAttempts?: number;
  /** When the current run started; absent while the step is not executing. */
  startedAt?: number;
  /** When the current run last wrote output, to within a minute; absent until it writes. */
  outputAt?: number;
  /** When a pooled step last went into its pool's queue: first pooled, or handed back to retry. */
  waitingSince?: number;
  completedAt?: number;
  exitCode?: number;
  error?: string;
};

export type PipelineInstanceStatus = {
  id: string;
  pipelineName: string;
  status: string;
  triggerPath: string;
  /** The fact that started it, for a fact-triggered pipeline. */
  triggerEvent?: DomainEvent;
  /** The pipeline's variables for this instance, after overrides. */
  vars?: Record<string, string>;
  startedAt: number;
  completedAt?: number;
  steps: PipelineStepStatus[];
};

export type InstancePage = { items: PipelineInstance[]; nextCursor: string | null };

/** `pipeline heal --json`: what one run did, or would do without `--apply`. Instances as `<pipeline>/<id>`. */
export type HealReport = {
  rerun: string[];
  /** Failed, and not yet due their next run. */
  waiting: number;
  /** Failed on their input: never run again. */
  input: number;
  /** Marked `needsPerson` by this run. */
  needsPerson: string[];
  /** Failed instances of a pipeline no longer defined: nothing can run them again. */
  retired: number;
};
