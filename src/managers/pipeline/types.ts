import type { DomainEvent } from '../../lib/events/mod.ts';
import type { Kind } from '../../lib/kinds/mod.ts';
import type { Attribution } from '../../lib/access/types.ts';
import type { UserId } from '../../lib/mode/mod.ts';
import type { AuditedWrite } from '../../lib/api/audit.ts';
import type { NodeAttrs } from '../../vfs/node.ts';

/**
 * Where matched triggers wait to become instances.
 *
 * Exported because it is not work in the sense the other pools are: the engine
 * claims from it itself rather than a worker, so anything reporting backlog has
 * to be able to tell it apart from a pool a job actually runs out of.
 */
export const TRIGGER_POOL = 'triggers';

/**
 * Pipeline definition (parsed from YAML)
 */

/**
 * What starts an instance. Two mutually exclusive forms:
 *
 * - `on`: domain event types read off `/dev/events` (`system.events`). The
 *   preferred form — a fact carries what the filter needs, so no shell round-trip
 *   back to the node is required.
 * - `event` + `nodeType`: a raw VFS mutation. Kept for pipelines that genuinely
 *   watch node shape rather than a domain fact.
 */
export type PipelineTrigger = {
  /** Domain event types (one or more) this pipeline triggers on. */
  on?: string[];
  /** VFS event type: created | updated | deleted | … */
  event?: string;
  /** VFS node type the event must be for. Required with `event`. */
  nodeType?: string;
  /**
   * Declarative pre-filter, evaluated in-process against the event's own fields:
   * `{ mimetype: 'image/*' }`. Keys are field names (matched case-insensitively
   * against both `EVENT_<NAME>` and `<NAME>` in the trigger env), values are
   * globs, or an array of globs meaning "any of". All keys must match.
   *
   * `filter` is a shell script, a spawn per definition per event; a shape test
   * on a field the event already carries does not cost a process.
   */
  match?: Record<string, string | string[]>;
  /**
   * Declarative exclusion, `match`'s counterpart with its keys and globs: skip the event when
   * every key matches (`{ mimetype: 'image/x-*' }`). Tested straight after `match`, so events a
   * pipeline leaves alone — a whole subtree's, by `nodePath` — cost no process however many
   * there are.
   */
  unless?: Record<string, string | string[]>;
  /**
   * Skip when this VFS path exists — the declarative form of the overwhelmingly
   * common `skipIf: info "$NODE_PATH/faces" >/dev/null`. `$NAME` from the
   * trigger env is substituted.
   */
  skipIfExists?: string;
  /**
   * Skip when the trigger node already carries this attr with a non-empty
   * value — the declarative form of `skipIf: attrs "$NODE_PATH" | jq -e .foo`.
   */
  skipIfAttr?: string;
  /**
   * Opt in to triggering on a *derived* file — a rendition (thumbnail,
   * transcode, face crop) or a `versions/` member such as a RAW filed behind
   * the JPG of the same shot. Defaults false, so no pipeline sees one unless it
   * says it wants to.
   *
   * The exclusion is default-on because the failure it prevents is silent. A
   * version is the same picture as its partner, so describing, face-detecting
   * or fingerprinting it doubles the indexing work and, worse, duplicates every
   * description and every face in search results — no error, just two of
   * everything.
   *
   * Tested on `sourceId` rather than a `versions/` path segment so it does not
   * depend on where the node happens to be linked, and `pipeline start` still
   * reaches a derived file deliberately — it creates the instance directly and
   * never passes through the trigger guards.
   */
  allowDerived?: boolean;
  /** Shell escape hatch, for anything `match` cannot express. Runs last. */
  filter?: string;
  /** Shell escape hatch for skip logic. Runs last. */
  skipIf?: string;
  /**
   * Definition variables to override for an instance started by this trigger.
   * Every name must be declared by the pipeline's top-level `vars` block.
   */
  vars?: Record<string, string>;
  /**
   * Scheduling priority for an instance started by this trigger. Falls back to
   * `options.priority`, so a low-priority backfill event can share a pipeline
   * with its ordinary live-work event without flattening their queue lanes.
   */
  priority?: number;
};

export type PipelineStep = {
  command: string;
  description?: string;
  dependsOn?: string[];
  condition?: string;
  /**
   * Delegate this step to `/var/pools/<pool>`, where a worker claims it under a
   * lease if its remaining capacity covers `requires`.
   *
   * Priority and requirements travel on the job, so one pool serves every
   * workload and retuning is an attrs edit rather than a service restart.
   */
  pool?: string;
  /** Capability class a worker filters on. Defaults to the step name. */
  kind?: string;
  /** What the step needs, matched against a worker's remaining capacity. */
  requires?: Record<string, number>;
  /**
   * Per-job priority, overriding the pipeline's `options.priority`. Higher runs
   * first, so one urgent file can outrank a backfill of the same pipeline.
   */
  priority?: number;
  /**
   * Mutex class: at most one job of this class runs across the whole pool.
   * Makes an ordering constraint explicit that would otherwise rest on a
   * worker's `--concurrency 1` by accident.
   */
  exclusive?: string;
};

type PipelineOptions = {
  maxAttempts?: number;
  /**
   * Scheduling priority for this pipeline's inline steps. **Higher runs first**;
   * default 0.
   *
   * The engine's concurrency semaphore hands a freed permit to the highest-priority
   * waiter, so a pipeline that produces many cheap instances cannot starve a more
   * valuable one just by queueing first (e.g. OCR over 126k photos vs face detection).
   * Not pre-emption: a running step keeps its permit until it finishes.
   *
   * A `pool` step does not take a permit; its priority travels on its pool job.
   */
  priority?: number;
  /**
   * Marks this pipeline as the one that means "this file has been taken in" —
   * the entry point everything else fans out from.
   *
   * It exists so the dashboard can say how far through the library an import
   * is without core having to know a media pipeline by name. Core owns the
   * question ("how much is left?"); the module that defines the crawl owns the
   * answer to "which pipeline decides that?".
   *
   * At most one pipeline should set it. If several do, the dashboard picks the
   * first by name and stays deterministic rather than guessing.
   *
   * The bare `true` form only names the entry point. The object form also says
   * how to *measure* it, which is the only form that produces a coverage
   * figure — see `EntryPointCoverage` for why counting instances cannot.
   */
  entryPoint?: boolean | EntryPointCoverage;
  /**
   * What a trigger that finds this pipeline's instance for the same subject still live does.
   *
   * `drop` (default) is the self-inflicted guard: the running DAG owns the node, and a trigger
   * arriving during the run — or inside the grace after it — is taken for the tail of the
   * pipeline's own writes and discarded. Right for a per-file pipeline, whose steps re-emit
   * events on their own subject.
   *
   * `rerun` is for a pipeline whose subject is an *aggregate* — an album, whose fact is derived
   * from its members and never from its own writes. There a trigger during the run is a real
   * change the run cannot have seen (the first photo of a crawl starts the instance; the next
   * 999 land while it runs), so the engine marks the live instance and re-announces the subject
   * once when it ends, folding every arrival during the run into one further run. The grace
   * window is not applied: a definition choosing this is stating that nothing it writes
   * re-emits its own trigger, and it is responsible for keeping that true.
   */
  coalesce?: 'drop' | 'rerun';
  /**
   * How long a matched trigger sits in the trigger pool before it can be claimed, in ms.
   *
   * The pool already collapses every announcement of one subject into one job; the hold is what
   * lets a burst arrive before that job is claimed, so a crawl into one album is one run rather
   * than a run per file. The clock starts at the first announcement (re-announcing never
   * postpones), so the bound on added latency is exactly this value.
   */
  debounceMs?: number;
};

/**
 * How to measure how much of the library has been taken in.
 *
 * Both halves are counts of nodes that exist, never counts of pipeline
 * instances that ran: instances are pruned to a per-pipeline cap, so a
 * completed-instance count stops moving at that cap.
 *
 * `marker` is the node type the pipeline creates exactly once per file it takes
 * in, so counting those *is* counting indexed files, and the count only ever
 * grows. It should name the same thing the trigger's `skipIfExists` tests, so
 * there is one definition of "indexed".
 */
export type EntryPointCoverage = {
  /** Content kinds whose non-derived files are the denominator. */
  kinds: Kind[];
  /** Node type created once per taken-in file — the numerator. */
  marker: string;
  /**
   * An attr (dotted for a nested one, `duplicate.deferred`) on the files the pipeline takes in
   * without making a marker, on purpose: they are left out of the denominator, so a crawl that is
   * done reads as done.
   */
  exempt?: string;
};

export type PipelineDef = {
  name: string;
  description?: string;
  /**
   * Alternative ways to start this pipeline. Guards and overrides belong to
   * one trigger, rather than being shared accidentally across every event.
   */
  triggers: PipelineTrigger[];
  steps: Record<string, PipelineStep>;
  options?: PipelineOptions;
  /**
   * Variables a step command may interpolate, with the default every run gets.
   * `pipeline start --var NAME=VALUE` overrides one for a single instance — the
   * knob a caller needs when one file has to be treated differently from the
   * crawl (`--var FORCE=-f` to re-encode a video that already has a rendition).
   *
   * Declaring them is what makes substitution total: an undeclared `$FORCE`
   * would survive into the shell, and a typo'd `--var` name would be ignored.
   */
  vars?: Record<string, string>;
};

/**
 * Pipeline instance state (VFS attrs)
 */

/**
 * Instance state.
 *
 * `running` and `queued` are both live — the instance holds unfinished work either way. They
 * differ on whether any of that work is *executing right now*:
 *
 *   running  at least one step is on a CPU or a GPU this instant, either dispatched inline by
 *            the engine or claimed by a pool worker.
 *   queued   unfinished, but nothing is executing: every remaining step is either 'waiting' in
 *            a pool nobody has claimed it from, or 'pending' on a dependency.
 *
 * A pool that runs one job at a time with ~100 ready has one running instance and ~99 queued.
 *
 * Use `isLiveInstance` for "not finished" rather than testing either value: every guard that
 * spells out `=== 'running'` is one that silently stops covering queued instances.
 */
export type PipelineStatus = 'running' | 'queued' | 'completed' | 'failed' | 'cancelled';

/**
 * Whether an instance still holds work, executing or not.
 *
 * The predicate nearly every caller wants. Recovery, cancellation, self-trigger suppression and
 * the "is a prior instance still alive" check are all about liveness and none of them care
 * which of the two live states it is in.
 */
export const isLiveInstance = (status: PipelineStatus): boolean => status === 'running' || status === 'queued';

/** The live statuses, for a query's `in` clause. */
export const LIVE_INSTANCE_STATUSES: PipelineStatus[] = ['running', 'queued'];

export type PipelineInstanceAttrs = NodeAttrs & {
  pipelineName: string;
  triggerPath: string;
  /**
   * Id of the node this instance was created for.
   *
   * `triggerPath` alone cannot say whether the subject is still there: a path
   * can come back as a *different* node, for instance when a later step writes a
   * child under a deleted subtree and `mknode -p` rebuilds the missing ancestors.
   *
   * Optional because an instance built by hand, as the repair command's
   * fixtures are, may have no id to compare; those fall back to existence.
   */
  triggerNodeId?: string;
  /** Who created the trigger node: what the run's steps create is recorded as theirs (`stepAttribution`). */
  triggerCreator?: UserId;
  status: PipelineStatus;
  /** When the instance was created — including all the time it has spent queued. */
  startedAt: number;
  /**
   * When the instance most recently *began executing*, set alongside `status: 'running'` and
   * cleared when it drops back to `queued`.
   *
   * `startedAt` cannot answer "how long has this been working": an instance behind ~100 queued
   * pool jobs is created, waits ten minutes, then runs for five seconds.
   *
   * Absent on queued instances; callers fall back to `startedAt` rather than showing nothing.
   */
  executingSince?: number;
  completedAt?: number;
  /**
   * The domain event that started this instance, when it was event-triggered.
   * Persisted so step commands and conditions get the same `$EVENT_*` env the
   * trigger filter saw — across restarts and `pipeline restart` — and so
   * `pipeline status` can show why the instance exists.
   */
  triggerEvent?: DomainEvent;
  /**
   * The write that set this run off: the one behind the VFS event, or the one the domain event was
   * derived from. Every write the run's steps make records its id as `cause` (`stepAttribution`),
   * so the trail leads back from each derived node by itself — the instance lives under `/var`,
   * which the trail skips and the pruner empties.
   */
  triggerWrite?: AuditedWrite;
  /**
   * The definition's `vars` with this run's trigger or command overrides
   * applied, resolved at creation so the engine substitutes without re-reading
   * the definition — and so a run keeps the values it was started with even if
   * the YAML changes under it.
   */
  vars?: Record<string, string>;
  /** Resolved scheduling priority for this run. */
  priority?: number;
  /** The lane this run is in (`DomainEvent.lane`); its jobs run `LANE_OFFSET` below `priority`. Absent is the normal lane. */
  lane?: Lane;
  /**
   * A trigger that arrived while this instance was live, under `options.coalesce: rerun`. The
   * engine re-announces the subject from it once the instance ends; the fresh instance is what
   * runs, this one is only the record that something arrived. Latest arrival wins — the fact it
   * carries is the newest, and one further run covers every arrival regardless.
   */
  rerun?: PendingRerun;
  /** How many times `pipeline heal` has run this work again after it failed; absent on a first run. */
  healAttempts?: number;
  /** Failed through every heal: left for a person, never run again by `pipeline heal`. */
  needsPerson?: boolean;
};

/**
 * What a step's writes are recorded as coming from: `sid` names the run as
 * `pipeline:<pipeline>/<subject node id>`, its instance's place under `instances/`, `cause` is
 * the write that set it off, and `creator` is the trigger node's, so what the run derives from a
 * person's node reads as theirs rather than the administrator's.
 */
export const stepAttribution = (instanceId: string, instance: PipelineInstanceAttrs): Attribution => ({
  sid: `pipeline:${instance.pipelineName}/${instanceId}`,
  ...(instance.triggerWrite ? { cause: instance.triggerWrite.auditId } : {}),
  ...(instance.triggerCreator !== undefined ? { creator: instance.triggerCreator } : {}),
});

/** A lane other than the normal one (`DomainEvent.lane`). */
export type Lane = NonNullable<DomainEvent['lane']>;

/**
 * Priority points a lane's work runs below the normal lane's: its trigger job, each pooled step
 * and its place at the engine's semaphore. Pipelines' priorities span 0 to 100, so no bulk job
 * ranks above a normal one. Bulk work is claimed whenever no normal work a claimer can take is
 * ready, so it is never stopped, only put behind. A pool's aging lifts a job by at most its
 * `agingMax` (`PoolResourceOptions`); kept below the offset, it reorders a step's bulk jobs among
 * themselves and never past the same step's normal ones.
 */
export const LANE_OFFSET: Record<Lane, number> = { bulk: -100 };

/** The priority offset of `lane`; 0 for the normal lane. */
export const laneOffset = (lane: Lane | undefined): number => lane === undefined ? 0 : LANE_OFFSET[lane];

/** What a folded trigger leaves behind for the run that follows. See `PipelineInstanceAttrs.rerun`. */
export type PendingRerun = {
  triggerEvent?: DomainEvent;
  triggerWrite?: AuditedWrite;
  vars?: Record<string, string>;
  priority?: number;
  /** When the folded trigger arrived, epoch ms. */
  at: number;
};

// Three of these are "not finished", and they differ on what the step is waiting for:
//
//   pending  dependencies unmet, not dispatched.
//   queued   dispatched, parked on the engine's concurrency semaphore waiting for a permit.
//   waiting  delegated to a pool; the job is queued there and the step is in-flight until the
//            owning worker finalises it.
//   running  on a core, right now.
//
// Recovery treats 'queued' exactly like 'running'.
export type StepStatus = 'pending' | 'queued' | 'waiting' | 'running' | 'completed' | 'failed' | 'skipped';

export type PipelineStepAttrs = NodeAttrs & {
  stepName: string;
  status: StepStatus;
  dependsOn: string[];
  command: string;
  condition?: string;
  pool?: string;
  kind?: string;
  requires?: Record<string, number>;
  priority?: number;
  exclusive?: string;
  /** Runs started so far. A pooled step's is the pool's count, written when a worker claims it. */
  attempts?: number;
  maxAttempts?: number;
  /** When the current run started; absent while the step is not executing. */
  startedAt?: number;
  /** When the current run last wrote output, to within a minute; absent until it writes. */
  outputAt?: number;
  /** When a pooled step last went into its pool's queue: first pooled, or handed back to retry. */
  waitingSince?: number;
  /** A step the engine runs itself, handed back because it could not run yet: not dispatched before this. */
  notBefore?: number;
  completedAt?: number;
  exitCode?: number;
  error?: string;
  /** Why a failed step failed when it was not the step's own doing: `input`, bytes that cannot be processed. */
  cause?: 'input';
};

/**
 * A delegated step's job payload. The worker resolves everything else (target
 * node, condition) from the instance / step node it points at, so the job stays
 * small and self-describing.
 */
export type PoolJobParams = {
  instancePath: string;
  stepName: string;
  command: string;
  /** What the step's writes are recorded as coming from (`stepAttribution`). */
  attribution?: Attribution;
};

/**
 * A matched trigger waiting to become an instance, in `/var/pools/triggers`.
 *
 * The trigger event is carried rather than re-derived: it is what the instance
 * records as `triggerEvent`, and the fact it describes has already happened, so
 * re-reading the node at claim time would only tell you something different.
 */
export type TriggerJobParams = {
  pipelineName: string;
  triggerPath: string;
  nodeId: string;
  triggerEvent?: DomainEvent;
  triggerWrite?: AuditedWrite;
  /** Resolved top-level defaults plus the matched trigger's overrides. */
  vars?: Record<string, string>;
  /** Resolved from the matched trigger, then the definition default. */
  priority?: number;
};
