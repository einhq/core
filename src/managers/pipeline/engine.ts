import { PIPELINE_QUEUE_PATH, PIPELINES_PATH, POOLS_PATH } from '../../lib/paths.ts';
import { basename, dirname, join } from '@std/path';
import { toText } from '@std/streams/to-text';
import { ulid } from '@std/ulid/ulid';
import { ADMIN_ACCESS, type Attribution } from '../../lib/access/mod.ts';
import type { AuditedWrite } from '../../lib/api/audit.ts';
import { STEP_EXIT_INPUT, STEP_EXIT_TEMPORARY } from '../../lib/step-exit.ts';
import { Mutex, Semaphore } from '../../lib/async/mod.ts';
import { type DomainEvent, eventEnv, EVENTS_ROUTING_KEY, isDomainEvent, PIPELINE_EVENTS_NODE_PATH, serializeEvent } from '../../lib/events/mod.ts';
import { globToRegex } from '../../lib/glob/mod.ts';
import { shq } from '../../lib/shell-quote/mod.ts';
import { createLogger } from '../logger/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../vfs/types/directory.ts';
import { isDerivedFile } from '../../vfs/types/file.ts';
import { NODE_TYPE_POOL } from '../../vfs/types/pool.ts';
import { NODE_TYPE_QUEUE } from '../../vfs/types/queue.ts';
import type { QueueAttrs } from '../../vfs/types/queue.ts';
import type { NodeVFS } from '../../vfs/node-vfs.ts';
import { NodeVersionConflictError } from '../../vfs/errors.ts';
import { type EventSubscription, type NodeAttrsUpdate, type NodeChildEntry, type NodeEvent, type NodeEventType, vfsRoutingKey } from '../../vfs/types.ts';
import type { Node, NodeId, NodePath, NodeType } from '../../vfs/node.ts';
import type { NodeQueryCursor } from '../../vfs/query.ts';
import type { UserId } from '../../lib/mode/mod.ts';
import type { PoolJob, PoolJobInput } from '../../registries/pool/mod.ts';
import type { ResourceHandleIf } from '../../registries/types.ts';
import type { TtyIf } from '../exec/types.ts';
import { parsePipeline } from './parse.ts';
import { DEFAULT_MAX_ATTEMPTS, instanceTree } from './step-attrs.ts';
import { stepErrorDetail, stepErrorLogDetail } from './step-error.ts';
import { markOutput, runStep } from './step-run.ts';
import {
  isLiveInstance,
  type Lane,
  laneOffset,
  LIVE_INSTANCE_STATUSES,
  type PendingRerun,
  type PipelineDef,
  type PipelineInstanceAttrs,
  type PipelineStatus,
  type PipelineStepAttrs,
  type PoolJobParams,
  stepAttribution,
  TARGET_MISSING,
  TRIGGER_POOL,
  type TriggerJobParams,
} from './types.ts';

const logger = createLogger('pipeline-engine');

/** Whether a definition folds triggers into a live instance rather than dropping them. */
const rerunsOnCoalesce = (def: PipelineDef): boolean => def.options?.coalesce === 'rerun';

const encoder = new TextEncoder();

/** The step statuses a lifecycle event reports, and the event each one is. */
const STEP_EVENTS: Partial<Record<PipelineStepAttrs['status'], string>> = {
  running: 'started',
  completed: 'completed',
  failed: 'failed',
  skipped: 'skipped',
};

/** A lifecycle event about one instance: its subject is the node the run is for. */
function lifecycleEvent(type: string, instancePath: string, instance: PipelineInstanceAttrs, data: Record<string, unknown> = {}): DomainEvent {
  return {
    id: ulid(),
    type,
    subject: instance.triggerPath,
    time: Date.now(),
    source: 'pipeline-engine',
    data: { pipeline: instance.pipelineName, instance: instancePath, ...data },
  };
}
const decoder = new TextDecoder();

/**
 * Grace past an instance's completion during which same-path triggers are treated
 * as self-inflicted (the tail of the pipeline's own writes). Covers async event
 * emission and clock skew; step writes themselves all land before completedAt.
 */
const SELF_TRIGGER_GRACE_MS = 5000;

/**
 * Lease on a trigger job. Creating an instance is a handful of node writes,
 * a few hundred ms, so this is two orders of magnitude of headroom, and no
 * heartbeat. If it were ever exceeded, the reclaimed job's second run finds the
 * instance it already created still `running` and `removePriorInstance` refuses
 * to replace it, so the duplicate is a no-op rather than a corruption.
 */
const TRIGGER_LEASE_MS = 60_000;

/**
 * Engines started in this process, so a second one on the same queue is refused
 * rather than silently doubling the work.
 *
 * `pipeline engine` is typeable directly and a service file can name it twice.
 * Two engines on one queue converge — the pool claim is keyed on the subject —
 * but every trigger is matched twice and every log line is emitted twice, which
 * is invisible unless you count them.
 *
 * Identity is the VFS instance plus the queue path, not the path alone: test
 * files boot whole systems in one process, and two systems sharing the default
 * `/var/queues/pipeline-engine` string are separate queues.
 */
const activeEngines = new Set<PipelineEngine>();

/** Instances re-advanced per recovery query. */
const RECOVER_PAGE = 200;

/** Admission poll interval, and how long it may stay shut before a self-heal pass. */
const ADMISSION_POLL_MS = 100;

/**
 * How long a step the engine runs itself waits before it runs again, when it could not run yet
 * (`STEP_EXIT_TEMPORARY`). A pooled step
 * rests its whole kind instead (see the pool worker); an inline one has no kind, so each step
 * waits on its own, long enough that a down service is not asked by every waiting step at once.
 */
const INLINE_TEMPORARY_WAIT_MS = 5 * 60_000;
/**
 * Default ceiling on instances the engine holds open. Bounded by the cost of
 * `kickOpenInstances`, which is one advance per open instance — not by heap,
 * which is what `maxAdmittedSteps` is for.
 */
const DEFAULT_MAX_OPEN_INSTANCES = 5000;
/**
 * Default gap between stuck sweeps. Overridable per instance (CFG_PIPELINE_STUCK_SWEEP_MS)
 * because a test cannot wait a minute to prove the repair runs on its own.
 */
const ADMISSION_KICK_MS = 60_000;
/** How far past `maxOpenInstances` fair-share admission may go; see `gateClosed`. */
const OPEN_INSTANCE_HARD_CAP_FACTOR = 2;
/**
 * Below this share of `maxOpenInstances` open, trigger claims ignore pipeline load and rotate;
 * see `claimTriggerFairly`.
 */
const LOAD_ORDER_FROM = 0.5;

/**
 * How long an instance may have no steps before that counts as a broken
 * creation rather than the create-time race `advanceDAGLocked` documents. The
 * race closes in milliseconds; this is generous so a loaded box is never
 * mistaken for a broken one.
 */
const EMPTY_INSTANCE_GRACE_MS = 5 * 60_000;

/**
 * Slim VFS event as published on the `system.vfs` routing key (see
 * LocalNodeVFS.emitEvent). It carries identity only — no node body/attrs — so the
 * engine resolves the current node from the VFS by path when it needs its attrs.
 */
type VfsTriggerEvent = {
  id: string;
  type: NodeEventType;
  path: NodePath;
  nodeId: NodeId;
  nodeType: NodeType;
  timestamp: number;
  uid: UserId;
  /** The audit record the write left, when the trail kept one. */
  auditId?: string;
};

/** Either kind of message the trigger queue can carry. */
type TriggerMessage = VfsTriggerEvent | DomainEvent;

/**
 * What one inline dispatch is for: the step node, by path and by id, and the attempt the advance
 * counted when it queued it. A step path outlives its node — an instance for a node is replaced
 * by the next one at the same path — so the path alone does not say whose step it is.
 */
type DispatchTicket = {
  instancePath: string;
  stepName: string;
  stepId: NodeId;
  attempt: number;
  /** What the step's writes are recorded as coming from (`stepAttribution`). */
  attribution: Attribution;
};

export class PipelineEngine {
  private definitions = new Map<string, PipelineDef>();
  private running = false;
  /** One queue handle per consume loop; a handle allows one unacked entry. */
  private handles: ResourceHandleIf[] = [];
  private abort = new AbortController();
  private sem: Semaphore;
  private inFlight = new Set<Promise<void>>();
  /**
   * One entry per instance the engine holds open — created on the first advance,
   * dropped when an advance sees the instance terminal. Serialises advances per
   * instance, and doubles as the count of open instances the admission gate uses
   * (see `maxAdmittedSteps`).
   */
  private advanceLocks = new Map<string, Mutex>();
  /** Cached append handle for the pipeline lifecycle event node. */
  private eventsHandle: Promise<ResourceHandleIf> | undefined;
  /** Lifecycle writes in the order their transitions happened; see `queueLifecycle`. */
  private lifecycleChain: Promise<void> = Promise.resolve();
  /** In-process subscriptions to the engine's own state nodes. */
  private subscriptions: EventSubscription[] = [];
  /** Keys with scheduled work pending, so repeats coalesce. */
  private pendingWork = new Set<string>();
  /** Instances with a step waiting for its `notBefore`, and the timer that advances each then. */
  private wakeups = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();
  /** The inline steps executing now, by step node id, each with what hangs its command up. */
  private runningInline = new Map<NodeId, AbortController>();
  /** Routing keys currently bound on the trigger queue. */
  private boundKeys: string[] = [];
  /** Root dir holding work pools. */
  private poolsRoot: string;
  /** Lease owner for trigger-pool claims. */
  private readonly triggerOwner: string;
  /** Trigger jobs being turned into instances right now. */
  private creating = new Set<Promise<void>>();
  /** Claimed triggers being created; briefly overlaps their new instance lock. */
  private creatingByPipeline = new Map<string, number>();
  /** The background recovery pass, so stop() can wait for it to unwind. */
  private recovering: Promise<void> | undefined;
  /** Resolves when a creation slot frees, so a full engine parks. */
  private triggerSlotFreed: (() => void) | undefined;
  /** Round-robin tie-break position across pipeline kinds for trigger admission. */
  private triggerCursor = 0;
  /** Round-robin tie-break position within pipelines declaring `options.entryPoint`. */
  private entryTriggerCursor = 0;
  /** Fractional reservation carried between trigger claims (0..99). */
  private entryAdmissionCredit = 0;
  /** When the last admission self-heal pass ran, and what was open at it. */
  private lastKickAt = Date.now();
  private lastKickOpen: string[] = [];

  constructor(
    private vfs: NodeVFS,
    private tty: TtyIf,
    private pipelinesPath = PIPELINES_PATH,
    private queuePath = PIPELINE_QUEUE_PATH,
    // Always bound. VFS keys are added per `event:`-form definition, so a system
    // with only domain-triggered pipelines never sees a raw VFS event.
    private routingKeys: string[] = [EVENTS_ROUTING_KEY],
    maxConcurrent = 4,
    private pipelineEventsPath = PIPELINE_EVENTS_NODE_PATH,
    poolsRoot = POOLS_PATH,
    private triggerConcurrency = 4,
    private consumeConcurrency = 4,
    /**
     * Work the engine will hold at once — dispatched steps *or* open instances,
     * whichever is higher. This is **admission** control, and it is separate
     * from `maxConcurrent`, which is execution control.
     *
     * A step is marked `queued`, its promise added to `inFlight`, and *then* it
     * parks on the semaphore, so every ready step of every live instance becomes
     * a parked promise holding its command, env and paths. Unbounded, a fast
     * trigger pool turns that into tens of thousands of promises and exhausts
     * the heap.
     *
     * This bounds `inFlight` and nothing else. Open instances are bounded
     * separately by `maxOpenInstances` — see there for why one number cannot
     * do both jobs.
     *
     * Work above this line waits as a durable pool row, which is the whole point
     * of having a pool — rows are cheap, parked promises are not.
     *
     * Not a hard ceiling: claims already in flight when the gate closes still
     * land, so admission overshoots by up to `triggerConcurrency` instances.
     * Bounded and small, which is all this needs to be.
     */
    private maxAdmittedSteps = maxConcurrent * 25,
    /**
     * How many instances the engine may hold open at once.
     *
     * A `pool:` step is marked `waiting` and handed to `/var/pools/*` without ever
     * reaching `dispatchStep`, so a pipeline whose steps are all delegated
     * contributes nothing to `inFlight`. Left uncounted entirely the engine would
     * keep claiming triggers while holding an unbounded number of instances
     * open, so `advanceLocks` is counted too.
     *
     * It is a separate limit from `maxAdmittedSteps` because the two cost orders
     * of magnitude apart: a dispatched step is a parked promise holding its
     * command, env and paths, while an open instance is a Map entry and a Mutex
     * whose work sits in Postgres. Charged at one rate, instances waiting on a
     * one-at-a-time GPU worker would hold every slot and lock other pipelines
     * out.
     *
     * What actually bounds this is `kickOpenInstances`, which re-advances open
     * instances and is therefore O(open) reads per sweep, at most every
     * `stuckSweepMs`. Raise CFG_PIPELINE_MAX_OPEN_INSTANCES only with that sweep
     * in mind.
     *
     * Admission orders ready pipelines by how much of this budget they already
     * hold, so a slow pipeline can borrow an otherwise idle ceiling without
     * locking out a newly ready one.
     */
    private maxOpenInstances = DEFAULT_MAX_OPEN_INSTANCES,
    /** How often `stuckSweepLoop` re-advances instances that have not moved. */
    private stuckSweepMs = ADMISSION_KICK_MS,
    /** Percentage of claims reserved for entry-point pipelines while they have work. */
    private entryAdmissionPercent = 0,
  ) {
    this.sem = new Semaphore(maxConcurrent);
    this.poolsRoot = poolsRoot;
    this.triggerOwner = `${Deno.hostname()}:${Deno.pid}:triggers`;
    this.entryAdmissionPercent = Math.max(0, Math.min(100, this.entryAdmissionPercent));
  }

  private get triggerPoolPath(): string {
    return join(this.poolsRoot, TRIGGER_POOL);
  }

  async start(): Promise<void> {
    for (const peer of activeEngines) {
      if (peer.vfs === this.vfs && peer.queuePath === this.queuePath) {
        throw new Error(
          `a pipeline engine is already running on ${this.queuePath}; ` +
            `use 'service restart pipeline-engine' instead of starting a second one`,
        );
      }
    }

    this.running = true;
    this.abort = new AbortController();
    activeEngines.add(this);
    logger.info('pipeline engine starting');

    await this.vfs.ensure(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, dirname(this.pipelinesPath), basename(this.pipelinesPath));
    await this.vfs.ensure(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, this.pipelinesPath, 'definitions');
    await this.vfs.ensure(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, this.pipelinesPath, 'instances');

    await this.loadDefinitions();

    // A stop requested during startup must not go on to open the queue and start
    // consuming — unwind now. The command's finally still runs the full stop().
    if (!this.running) {
      logger.info('pipeline engine stop requested during startup');
      return;
    }

    // Durable trigger queue: trigger events persist until acked, so an upload
    // while the engine is down is not lost. It carries triggers only — the
    // engine's own instance/step churn is watched in-process (see
    // watchInternalNodes), which is what keeps this queue small.
    const queueDir = dirname(this.queuePath);
    await this.vfs.ensure(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, dirname(queueDir), basename(queueDir));
    await this.vfs.ensure<QueueAttrs>(
      ADMIN_ACCESS,
      NODE_TYPE_QUEUE,
      dirname(this.queuePath),
      basename(this.queuePath),
      { attrs: { routingKeys: this.triggerRoutingKeys() } },
    );
    await this.syncQueueBinding();

    // One handle per consumer: a queue handle allows a single unacked entry, so
    // concurrency here is N handles competing on the same subscription, not a
    // faster loop. Matching is in-process and enqueueing is one upsert, so the
    // cost of a message is dominated by its round trips — which parallelise.
    // Tracked as they open, not gathered at the end: a failure partway through
    // still leaves the successful ones for stop() to close.
    for (let i = 0; i < this.consumeConcurrency; i++) {
      this.handles.push(await this.vfs.open(ADMIN_ACCESS, this.queuePath, { mode: 'r+' }));
    }

    await this.watchInternalNodes();

    // Re-advance instances interrupted by the last stop. Backgrounded and
    // admission-gated: with a large backlog this is not seconds of work, and
    // nothing about it needs to finish before new triggers are consumed.
    this.recovering = this.recover().catch((err) => logger.error('recover error', { error: err }));

    // Run the consumer loops in the background — do not await them.
    for (const handle of this.handles) {
      this.consumeLoop(handle).catch((err) => logger.error('consume loop error', { error: err }));
    }
    this.triggerClaimLoop().catch((err) => logger.error('trigger claim loop error', { error: err }));
    this.stuckSweepLoop().catch((err) => logger.error('stuck sweep error', { error: err }));

    logger.info('pipeline engine started', {
      definitions: this.definitions.size,
      consumers: this.handles.length,
    });
  }

  /**
   * Cooperative cancel: flip the flags that start()/recover()/consumeLoop and
   * dispatchStep check, so a stop requested mid-startup (e.g. a rapid `service
   * restart` landing while recover() drains a backlog) unwinds promptly instead
   * of running the whole recover and then being force-torn-down under a still-
   * writing shell. stop() does the actual resource cleanup; safe to call any
   * number of times, and before start() has opened anything.
   */
  requestStop(): void {
    this.running = false;
    this.abort.abort();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort.abort();
    activeEngines.delete(this);
    for (const { timer } of this.wakeups.values()) clearTimeout(timer);
    this.wakeups.clear();
    for (const sub of this.subscriptions) {
      try {
        await sub.unsubscribe();
      } catch { /* best effort */ }
    }
    this.subscriptions = [];
    // Closing auto-nacks each consumer's in-flight entry for redelivery.
    await Promise.allSettled(this.handles.map((handle) => handle.close()));
    this.handles = [];
    // Recovery checks `running` between instances, so this unwinds promptly.
    if (this.recovering) {
      await this.recovering;
      this.recovering = undefined;
    }
    // Let in-flight steps settle; any still mid-run stay 'running' and are recovered.
    await Promise.allSettled([...this.inFlight]);
    // Same for trigger jobs: letting each finish releases its claim properly.
    // One abandoned mid-create would only sit `claimed` until its lease lapses
    // and the pool's sweep hands it back, but that is 60s of latency per job.
    await Promise.allSettled([...this.creating]);
    if (this.eventsHandle) {
      try {
        await (await this.eventsHandle).close();
      } catch { /* best effort */ }
      this.eventsHandle = undefined;
    }
    logger.info('pipeline engine stopped');
  }

  private async consumeLoop(handle: ResourceHandleIf): Promise<void> {
    while (this.running) {
      let event: TriggerMessage;
      try {
        const bytes = await handle.read(1, this.abort.signal);
        if (bytes.length === 0) {
          // Empty read means we were aborted/closed — otherwise it's a transient
          // blip (e.g. Postgres restarting mid-init on a clean DB) that the queue
          // couldn't ride out. Back off and retry rather than break: a silent
          // break leaves the engine "started" but permanently deaf to triggers.
          if (!this.running || this.abort.signal.aborted) break;
          logger.warn('empty queue read while running, retrying');
          await this.backoff();
          continue;
        }
        event = JSON.parse(decoder.decode(bytes)) as TriggerMessage;
      } catch (err) {
        if (!this.running || this.abort.signal.aborted) break;
        logger.error('failed to read queue event, retrying', { error: err });
        await this.backoff();
        continue;
      }

      try {
        await this.dispatch(event);
        await handle.write(encoder.encode('ack\n'));
      } catch (err) {
        const path = isDomainEvent(event) ? event.subject : event?.path;
        logger.error('event processing failed, nacking', { error: err, path });
        try {
          await handle.write(encoder.encode('nack\n'));
        } catch (nackErr) {
          logger.error('failed to nack', { error: nackErr });
        }
      }
    }
  }

  /** Short delay between consume retries, resolving early if the engine stops. */
  private backoff(ms = 1000): Promise<void> {
    return new Promise((resolve) => {
      const signal = this.abort.signal;
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  private async dispatch(message: TriggerMessage): Promise<void> {
    if (!this.running) return;

    // A domain event is a fact about a node, not a mutation of one.
    if (isDomainEvent(message)) {
      await this.handleDomainTrigger(message);
      return;
    }

    await this.handleTrigger(message);
  }

  /**
   * Watch the engine's own state in-process instead of round-tripping it through
   * the durable queue.
   *
   * Instance and step nodes churn constantly — every step transition is a node
   * update — and persisting each one only to read it back would fill the
   * trigger queue. Durability buys nothing here: recover() re-advances every
   * live instance at startup, which is exactly what a replayed event would do.
   *
   * Handlers schedule onto a macrotask rather than advancing inline, through
   * `schedule()`: a burst of step updates on one instance collapses into a
   * single advance, and the engine's own writes do not recurse into it.
   */
  private async watchInternalNodes(): Promise<void> {
    if (!this.vfs.subscribe) return;

    const definitionsPath = join(this.pipelinesPath, 'definitions');
    const instancesPath = join(this.pipelinesPath, 'instances');

    this.subscriptions.push(
      // A definition changed (`pipeline define` after boot, or a module set up
      // post-boot) — reload without a restart. Coalesced under one key, so a
      // burst of module setups costs one reload.
      await this.vfs.subscribe(() => ADMIN_ACCESS, () => {
        this.schedule('definitions', () => this.loadDefinitions());
      }, { pathPrefix: definitionsPath, eventTypes: ['created', 'updated', 'deleted'] }),
    );

    this.subscriptions.push(
      // An instance node changed (`pipeline start` created one, `pipeline restart`
      // reset its steps) or a step node did — a pool worker finalises delegated
      // steps out of process, so their completion only shows up as a step update.
      // Either way, advancing the owning instance picks it up; the engine's own
      // writes land here too and are cheap no-ops (advanceDAG is idempotent).
      // Every writer's transitions pass through here, which is why the lifecycle
      // events for a run starting and for each step are emitted from it.
      await this.vfs.subscribe(() => ADMIN_ACCESS, (event) => {
        const instancePath = this.isInstanceNode(event.path) ? event.path : this.isStepNode(event.path) ? dirname(dirname(event.path)) : undefined;

        if (!instancePath) return;

        if (instancePath === event.path) this.observeInstance(event as NodeEvent<PipelineInstanceAttrs>);
        else {
          this.observeStep(instancePath, event as NodeEvent<PipelineStepAttrs>);
          this.hangUpOverruled(event as NodeEvent<PipelineStepAttrs>);
        }

        this.schedule(instancePath, () => this.advanceDAG(instancePath));
      }, { pathPrefix: instancesPath, eventTypes: ['created', 'updated'] }),
    );
  }

  /**
   * Run `fn` on a macrotask, coalescing repeats under the same key while one is
   * already pending. Tracked in `inFlight` so stop() waits for it.
   */
  private schedule(key: string, fn: () => Promise<void>): void {
    if (this.pendingWork.has(key)) return;
    this.pendingWork.add(key);

    const work = new Promise<void>((resolve) => {
      setTimeout(async () => {
        this.pendingWork.delete(key);

        if (!this.running) {
          resolve();
          return;
        }

        try {
          await fn();
        } catch (err) {
          logger.error('scheduled work failed', { key, error: String(err) });
        }

        resolve();
      }, 0);
    });

    this.inFlight.add(work);
    work.finally(() => this.inFlight.delete(work));
  }

  /**
   * Advance `instancePath` again at `at`, for a step that may not run before then. One timer per
   * instance, kept for the earliest time asked; the advance it starts re-arms it for a later step.
   * Not persisted: recovery advances every live instance after a restart, which arms it again.
   */
  private wakeAt(instancePath: string, at: number): void {
    const armed = this.wakeups.get(instancePath);
    if (armed && armed.at <= at) return;
    if (armed) clearTimeout(armed.timer);
    const timer = setTimeout(() => {
      this.wakeups.delete(instancePath);
      this.schedule(instancePath, () => this.advanceDAG(instancePath));
    }, Math.max(0, at - Date.now()));
    this.wakeups.set(instancePath, { at, timer });
  }

  /** True if `path` is an instance node: `<pipelinesPath>/instances/<pipeline>/<id>`. */
  private isInstanceNode(path: string): boolean {
    const prefix = join(this.pipelinesPath, 'instances') + '/';
    if (!path.startsWith(prefix)) return false;
    return path.slice(prefix.length).split('/').filter(Boolean).length === 2;
  }

  /** True if `path` is a step node: `<pipelinesPath>/instances/<pipeline>/<id>/steps/<name>`. */
  private isStepNode(path: string): boolean {
    const prefix = join(this.pipelinesPath, 'instances') + '/';
    if (!path.startsWith(prefix)) return false;
    const parts = path.slice(prefix.length).split('/').filter(Boolean);
    return parts.length === 4 && parts[2] === 'steps';
  }

  /**
   * Reload pipeline definitions from `<pipelinesPath>/definitions`. Incremental:
   * only definitions whose parsed content changed are logged, and definitions
   * whose files vanished are dropped. This keeps the boot-time replay burst (one
   * event per definition, each re-reading all) quiet instead of logging every
   * definition on every event.
   */
  async loadDefinitions(): Promise<void> {
    const defsPath = join(this.pipelinesPath, 'definitions');

    let entries;
    try {
      entries = await this.vfs.children(ADMIN_ACCESS, defsPath);
    } catch {
      if (this.definitions.size > 0) this.definitions.clear();
      logger.debug('no pipeline definitions found');
      return;
    }

    const seen = new Set<string>();
    for (const entry of entries) {
      try {
        const yamlPath = join(defsPath, entry.name);
        const handle = await this.vfs.open(ADMIN_ACCESS, yamlPath, { mode: 'r' });
        let yaml: string;
        try {
          yaml = await toText(handle.readable);
        } finally {
          await handle.close();
        }

        const def = parsePipeline(yaml);
        seen.add(def.name);
        const prev = this.definitions.get(def.name);
        this.definitions.set(def.name, def);
        if (!prev || JSON.stringify(prev) !== JSON.stringify(def)) {
          logger.info('loaded pipeline definition', { name: def.name });
        }
      } catch (err) {
        logger.error('failed to load pipeline definition', { name: entry.name, error: err });
      }
    }

    // Drop definitions whose backing files are gone.
    for (const name of [...this.definitions.keys()]) {
      if (!seen.has(name)) {
        this.definitions.delete(name);
        logger.info('unloaded pipeline definition', { name });
      }
    }

    // A definition using the `event:` form needs its VFS routing key bound; one
    // that stopped using it should stop costing the queue anything.
    await this.syncQueueBinding();
    await this.ensureResourcePools();
  }

  /**
   * Ensure a pool node exists for every `pool` a step names, so jobs are
   * captured before any worker attaches. Policy (aging, leases) is deliberately
   * left at the node's defaults: it is operator-tunable via attrs, and a
   * definition reload must not stamp on a tuned pool.
   */
  private async ensureResourcePools(): Promise<void> {
    // The trigger pool is unconditional: it holds matched work for every
    // pipeline, whether or not any step delegates.
    const pools = new Set<string>([TRIGGER_POOL]);

    for (const def of this.definitions.values()) {
      for (const step of Object.values(def.steps)) {
        if (step.pool) pools.add(step.pool);
      }
    }

    for (const pool of pools) {
      try {
        await this.vfs.ensure(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, dirname(this.poolsRoot), basename(this.poolsRoot));
        await this.vfs.ensure(ADMIN_ACCESS, NODE_TYPE_POOL, this.poolsRoot, pool);
      } catch (err) {
        logger.error('failed to ensure pool', { pool, error: err });
      }
    }
  }

  /**
   * Routing keys the trigger queue must bind: domain events always, plus exactly
   * the VFS keys the loaded `event:`-form definitions ask for. A pipeline
   * watching `updated`/`file` costs one key; nothing else in the system's event
   * traffic reaches the queue at all.
   */
  private triggerRoutingKeys(): string[] {
    const keys = new Set(this.routingKeys);

    for (const def of this.definitions.values()) {
      for (const trigger of def.triggers) {
        if (trigger.event && trigger.nodeType) {
          keys.add(vfsRoutingKey(trigger.nodeType as NodeType, trigger.event as NodeEventType));
        }
      }
    }

    return [...keys].sort();
  }

  /** Rebind the trigger queue when the loaded definitions change what it needs. */
  private async syncQueueBinding(): Promise<void> {
    const keys = this.triggerRoutingKeys();

    if (keys.length === this.boundKeys.length && keys.every((key, i) => key === this.boundKeys[i])) {
      return;
    }

    // loadDefinitions runs before start() creates the queue; it is ensured with
    // these same keys moments later, so there is nothing to rebind yet.
    if (!await this.vfs.exists(ADMIN_ACCESS, this.queuePath)) {
      return;
    }

    try {
      await this.vfs.update<QueueAttrs>(ADMIN_ACCESS, this.queuePath, { attrs: { routingKeys: keys } });
      this.boundKeys = keys;
      logger.info('trigger queue bindings updated', { routingKeys: keys });
    } catch (err) {
      logger.error('failed to update trigger queue bindings', { error: String(err) });
    }
  }

  /**
   * Where the job carrying a pooled step stands: `claimed` by a worker, `ready` for one, or
   * `gone` — neither, so nothing is behind the step and no sweep will ever come for it.
   *
   * `ready`/`claimed` is the whole of "in flight": a claimed job's lease is heartbeated while
   * the step runs and returned to `ready` by the pool's sweep if the worker dies. A point lookup
   * on the dedup index, not a scan of the backlog.
   *
   * Undefined when the pool cannot be read, so an unreadable pool leaves the step alone rather
   * than duplicating work.
   */
  private async pooledJobState(pool: string, stepPath: string): Promise<'claimed' | 'ready' | 'gone' | undefined> {
    try {
      const [live] = await this.vfs.poolJobs(ADMIN_ACCESS, join(this.poolsRoot, pool), {
        state: ['ready', 'claimed'],
        dedupKey: stepPath,
        limit: 1,
      });
      return live === undefined ? 'gone' : live.state === 'claimed' ? 'claimed' : 'ready';
    } catch {
      return undefined;
    }
  }

  /**
   * Put a pooled step a worker had started back to what its job says, when no worker has it.
   *
   * Job `gone`: back to `pending`, to be pooled afresh — re-adding the job alone would not do,
   * because `staleReason` drops any job whose step is not `waiting`. Job `ready`: the pool's
   * sweep reclaimed the lease of a worker that died, and the job waits for the next one; the
   * step goes back to `waiting` with it, or that worker would drop the job as stale and nobody
   * would be doing the work the step still claims as `running`. `attempts` stays: the dead
   * worker's run is counted, as the pool counted it.
   *
   * Returns the status written, or undefined when the step was left as it was.
   */
  private async repairStartedPooledStep(instancePath: string, stepsPath: string, stepName: string, pool: string): Promise<'pending' | 'waiting' | undefined> {
    const stepPath = join(stepsPath, stepName);
    const job = await this.pooledJobState(pool, stepPath);

    if (job === 'gone') {
      await this.vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, stepPath, {
        attrs: { status: 'pending', startedAt: undefined },
      });
      logger.warn('pooled step lost its job, re-queued', { step: stepName, instance: instancePath });
      return 'pending';
    }

    if (job === 'ready') {
      await this.vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, stepPath, {
        attrs: { status: 'waiting', startedAt: undefined, outputAt: undefined },
      });
      logger.info('pooled step lost its worker, waiting on its requeued job', { step: stepName, instance: instancePath });
      return 'waiting';
    }

    return undefined;
  }

  /**
   * Re-add the job for a step that believes it is waiting on a pool.
   *
   * Only touches the pool when the job is genuinely absent: `add` would upsert
   * harmlessly, but a blind re-add on every advance would reset the backoff of a
   * job that is deliberately waiting out a retry.
   */
  private async reconcilePoolJob(
    instancePath: string,
    stepsPath: string,
    stepName: string,
    attrs: PipelineStepAttrs,
    quotedEnv: Record<string, string>,
    instancePriority: number,
    offset: number,
  ): Promise<void> {
    const stepPath = join(stepsPath, stepName);

    if (await this.pooledJobState(attrs.pool!, stepPath) !== 'gone') return;

    // The scheduling half of the step — kind, requirements, priority, mutex class — is taken
    // from the definition as it is *now*, not from the snapshot the instance was created with,
    // so a kind renamed under queued work is restored under its new name, not left unservable.
    // The command is the instance's own and is not touched. Only a definition that still has
    // this step on the same pool is consulted — anything else keeps the snapshot.
    const current = this.definitions.get(this.instancePipelineName(instancePath))?.steps[stepName];
    const scheduling = current !== undefined && current.pool === attrs.pool
      ? { kind: current.kind, requires: current.requires, priority: current.priority, exclusive: current.exclusive }
      : { kind: attrs.kind, requires: attrs.requires, priority: attrs.priority, exclusive: attrs.exclusive };

    logger.info('restoring lost pool job', { step: stepName, instance: instancePath, kind: scheduling.kind ?? stepName });

    if (scheduling.kind !== attrs.kind || JSON.stringify(scheduling.requires) !== JSON.stringify(attrs.requires)) {
      await this.vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, stepPath, {
        attrs: { kind: scheduling.kind, requires: scheduling.requires },
      });
    }

    await this.addPoolJob(attrs.pool!, stepPath, {
      kind: scheduling.kind ?? stepName,
      priority: (scheduling.priority ?? instancePriority) + offset,
      requires: scheduling.requires,
      exclusive: scheduling.exclusive,
      maxAttempts: attrs.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      // The runs it already had: a job lost with a dead worker does not start its count over.
      attempts: attrs.attempts,
      params: {
        instancePath,
        stepName,
        command: this.substitute(attrs.command, quotedEnv),
      } satisfies PoolJobParams,
    });
  }

  /** The definition an instance was started from, by its location under `instances/<name>/`. */
  private instancePipelineName(instancePath: string): string {
    const prefix = join(this.pipelinesPath, 'instances') + '/';
    return instancePath.startsWith(prefix) ? instancePath.slice(prefix.length).split('/')[0] : '';
  }

  /**
   * Add (or refresh) the pool job backing a delegated step. The dedup key is
   * the step path, so this is idempotent and the caller can re-run it freely.
   *
   * The step is read again once the job is in. `pipeline cancel` skips a step and then drops its
   * job, without this engine's lock, so an advance that read the step `waiting`, or wrote it so
   * before the cancel came, can add the job after the cancel dropped it. Whichever of the skip
   * and this read comes second sees the other: a step found skipped here loses its job, and one
   * not yet skipped has the cancel's drop still to come (ein/core#722).
   */
  private async addPoolJob(pool: string, stepPath: string, job: Omit<PoolJobInput, 'dedupKey'>): Promise<void> {
    const poolPath = join(this.poolsRoot, pool);
    try {
      await this.vfs.poolAdd(ADMIN_ACCESS, poolPath, { ...job, dedupKey: stepPath });
    } catch (err) {
      // Leaving the step 'waiting' is correct: the next advance retries the add,
      // and until then the step is visibly stuck rather than silently dropped.
      logger.error('failed to add pool job', { pool, step: stepPath, error: err });
      return;
    }

    let cancelled: boolean;
    try {
      cancelled = (await this.vfs.get<PipelineStepAttrs>(ADMIN_ACCESS, stepPath)).attrs.status === 'skipped';
    } catch {
      cancelled = true; // Removed with its instance.
    }
    if (!cancelled) return;

    try {
      await this.vfs.poolCancel(ADMIN_ACCESS, poolPath, { dedupKey: stepPath });
    } catch {
      // Pool or job already gone — nothing to drop.
    }
    logger.info('pool job added for a step cancelled meanwhile, dropped', { pool, step: stepPath });
  }

  /** `pipeline.instance.completed` / `.failed`, naming the steps that failed. */
  private async emitLifecycle(
    status: 'completed' | 'failed',
    instancePath: string,
    instance: PipelineInstanceAttrs,
    steps: Map<string, PipelineStepAttrs>,
  ): Promise<void> {
    const failed = [...steps.values()].filter((s) => s.status === 'failed').map((s) => s.stepName);

    await this.queueLifecycle(() =>
      Promise.resolve(lifecycleEvent(`pipeline.instance.${status}`, instancePath, instance, {
        ...(failed.length > 0 ? { failedSteps: failed } : {}),
      }))
    );
  }

  /**
   * `pipeline.instance.started` when an instance node is created, or put back
   * to live from terminal (`pipeline restart`).
   */
  private observeInstance(event: NodeEvent<PipelineInstanceAttrs>): void {
    const attrs = event.node.attrs;
    if (!isLiveInstance(attrs.status)) return;

    const previous = event.previousNode?.attrs.status;
    if (event.type === 'updated' && (previous === undefined || isLiveInstance(previous))) return;

    void this.queueLifecycle(() => Promise.resolve(lifecycleEvent('pipeline.instance.started', event.path, attrs)));
  }

  /**
   * `pipeline.step.started` when a step goes 'running', and
   * `pipeline.step.completed` / `.failed` / `.skipped` when it ends. A retry
   * runs again, so one step can start more than once; `attempts` tells them apart.
   */
  private observeStep(instancePath: string, event: NodeEvent<PipelineStepAttrs>): void {
    const attrs = event.node.attrs;
    if (event.previousNode?.attrs.status === attrs.status) return;

    const transition = STEP_EVENTS[attrs.status];
    if (!transition) return;

    void this.queueLifecycle(async () => {
      let instance: PipelineInstanceAttrs;
      try {
        instance = (await this.vfs.get<PipelineInstanceAttrs>(ADMIN_ACCESS, instancePath)).attrs;
      } catch {
        return undefined; // The instance went with its steps; there is no run left to report on.
      }

      return lifecycleEvent(`pipeline.step.${transition}`, instancePath, instance, {
        step: attrs.stepName,
        ...(attrs.attempts !== undefined ? { attempts: attrs.attempts } : {}),
        ...(attrs.status === 'failed' && attrs.exitCode !== undefined ? { exitCode: attrs.exitCode } : {}),
        ...(attrs.status === 'failed' && attrs.cause ? { cause: attrs.cause } : {}),
      });
    });
  }

  /**
   * Hang up an inline step's command when someone else moves its step out of `running` under it:
   * `pipeline-step-restart` sets it back to `pending`, a cancel to `skipped`. The run's outcome is
   * then not written (`dispatchStep`), so the step keeps what was set.
   */
  private hangUpOverruled(event: NodeEvent<PipelineStepAttrs>): void {
    if (event.node.attrs.status === 'running') return;
    this.runningInline.get(event.node.id)?.abort();
  }

  /**
   * Append a lifecycle event to the pipeline events node, behind every one
   * queued before it.
   *
   * Callers queue synchronously at the transition, and `build` may read the VFS,
   * so without the chain a step's event could land after the instance's
   * completion that followed it. Tracked in `inFlight` so stop() waits for it
   * before closing the handle.
   */
  private queueLifecycle(build: () => Promise<DomainEvent | undefined>): Promise<void> {
    const write = this.lifecycleChain.then(async () => {
      let event: DomainEvent | undefined;

      try {
        event = await build();
        if (!event) return;

        if (!this.eventsHandle) {
          this.eventsHandle = this.vfs.open(ADMIN_ACCESS, this.pipelineEventsPath, { mode: 'a' });
        }

        const handle = await this.eventsHandle;
        await handle.write(encoder.encode(serializeEvent(event)));
      } catch (err) {
        // A missing pipeline events node (e.g. in a test harness) must not matter
        this.eventsHandle = undefined;
        logger.debug('failed to emit pipeline lifecycle event', { type: event?.type, error: String(err) });
      }
    });

    this.lifecycleChain = write;
    this.inFlight.add(write);
    write.finally(() => this.inFlight.delete(write));
    return write;
  }

  /**
   * Re-advance instances left `running` by a previous process.
   *
   * Runs in the background and pages an indexed query, rather than blocking
   * `start()` while it lists every instance directory: tens of thousands of live
   * instances are a lot of node objects to hold at once, and recovering them all
   * before opening the trigger queue would keep the engine from starting.
   *
   * Paging by `startedAt` is safe against the mutation it causes: an instance
   * that goes terminal simply drops out of the filter, and the cursor only ever
   * moves forward.
   */
  private async recover(): Promise<void> {
    const prefix = join(this.pipelinesPath, 'instances') + '/';
    let cursor: NodeQueryCursor | undefined;
    let recovered = 0;

    while (this.running) {
      let page;
      try {
        page = await this.vfs.query(ADMIN_ACCESS, {
          where: [
            { ref: 'status', op: 'in', value: [...LIVE_INSTANCE_STATUSES] },
            { ref: 'pipelineName', op: 'exists' },
          ],
          orderBy: { ref: 'startedAt', dir: 'asc' },
          after: cursor,
          limit: RECOVER_PAGE,
        });
      } catch (err) {
        logger.error('recovery query failed', { error: err });
        return;
      }

      if (page.length === 0) break;

      for (const row of page) {
        if (!this.running) return; // stop requested mid-recover — bail promptly
        cursor = { value: row.sortValue, id: row.id };

        if (!row.absPath.startsWith(prefix)) continue;

        // Recovery goes through the same admission gate as new work, or a crash
        // becomes a crash *loop*: the instances left `running` by an engine that
        // died of too many of them are exactly what this would re-dispatch, all
        // at once, on the next start.
        // Strictly: recovery does not choose by kind, so the fair-share opening past the
        // ceiling (see `gateClosed`) must not let it re-open a hog's backlog up to the hard cap.
        await this.waitForAdmission(true);
        if (!this.running) return;

        logger.debug('recovering pipeline instance', { path: row.absPath });

        // A step left 'running' or 'queued' when the engine died was
        // interrupted mid-execution — reset it to 'pending' so it re-runs.
        // Sound because step commands are idempotent and guarded by their
        // condition. Keep `attempts` so a crash-looping step still exhausts retries.
        await this.resetInterruptedSteps(row.absPath);
        await this.advanceDAG(row.absPath);
        recovered++;
      }
    }

    if (recovered > 0) logger.info('recovered pipeline instances', { count: recovered });
  }

  private async resetInterruptedSteps(instancePath: string): Promise<void> {
    const stepsPath = join(instancePath, 'steps');
    let steps;
    try {
      steps = await this.vfs.children<PipelineStepAttrs>(ADMIN_ACCESS, stepsPath);
    } catch {
      return;
    }
    for (const step of steps) {
      const attrs = step.node.attrs;
      const status = attrs.status;

      // Pooled steps are normally owned by their lease, which is renewed while
      // the step runs and reclaimed by the pool's sweep when a worker dies. That
      // is real crash detection, so there is nothing to guess at here — no
      // age heuristic, and no reset that would race a live worker.
      //
      // It stops being true the moment the job itself is gone. Then no lease
      // exists to expire, no sweep will ever reclaim anything, and the step
      // stays 'running' for good — holding its instance open, and with it an
      // admission slot. And once the sweep has reclaimed the lease, the job is
      // `ready` again while the step still says 'running'. So check instead of
      // assuming; the check is one indexed lookup.
      if (attrs.pool) {
        if (status === 'running') await this.repairStartedPooledStep(instancePath, stepsPath, step.name, attrs.pool);
        continue;
      }

      if (status === 'running' || status === 'queued') {
        await this.vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, join(stepsPath, step.name), {
          attrs: { status: 'pending', startedAt: undefined },
        });
      }
    }
  }

  /**
   * A domain fact arrived on `/dev/events`. Unlike a VFS event it already carries
   * everything a filter needs in `data`, so matching costs no round-trip back to
   * the node — that is what makes per-capability pipelines affordable.
   */
  private async handleDomainTrigger(event: DomainEvent): Promise<void> {
    if (!this.running) return;

    const env = eventEnv(event);
    const timestamp = event.time ?? Date.now();
    // Resolved lazily and once — an event nobody listens for costs nothing.
    let nodeId = event.nodeId;
    let resolved = nodeId !== undefined;
    // The subject's attrs, read at most once per event and shared by every
    // definition — the derived guard and `skipIfAttr` both want them, and a
    // fact's subject is the same node for the whole loop.
    const subjectAttrs = this.attrsReader(event.subject);

    for (const [, def] of this.definitions) {
      const triggers = def.triggers.filter((trigger) => trigger.on?.includes(event.type));
      if (triggers.length === 0) continue;

      // Resolve once, shared across every definition that wants this fact, and
      // before the filters: one lookup is far cheaper than the shell spawns
      // knowing the node lets us skip.
      if (!resolved) {
        nodeId = (await this.resolveNode(event.subject))?.id;
        resolved = true;
      }

      if (!nodeId) {
        logger.warn('domain event for an unknown node', { event: event.type, path: event.subject });
        return;
      }

      // Cheapest rejection first. This is one direct get against an instance
      // named after the node, and it is the common outcome on a busy corpus:
      // anything re-announcing work already in flight stops here instead of
      // paying for filter + skipIf shell evaluations nobody acts on.
      //
      // Not under `coalesce: rerun`: there a live instance is not a reason to
      // drop but a reason to run again, and that verdict is reached after the
      // guards below, so a fact the trigger would have declined cannot force a
      // rerun (`admitTrigger`).
      if (!rerunsOnCoalesce(def) && await this.isSelfInflictedTrigger(def.name, nodeId, timestamp)) {
        logger.debug('skipping trigger (self-inflicted or in-flight)', { pipeline: def.name, path: event.subject });
        continue;
      }

      for (const trigger of triggers) {
        // Declarative checks first — they cost no process at all.
        if (trigger.match && !this.matchesTrigger(trigger.match, env)) continue;

        if (trigger.unless && this.matchesTrigger(trigger.unless, env)) {
          logger.debug('skipping pipeline (unless matched)', { pipeline: def.name, path: event.subject });
          continue;
        }

        if (!trigger.allowDerived && isDerivedFile(await subjectAttrs())) {
          logger.debug('skipping pipeline (derived subject)', { pipeline: def.name, path: event.subject });
          continue;
        }

        if (trigger.skipIfExists && await this.skipBecauseExists(trigger.skipIfExists, env)) {
          logger.debug('skipping pipeline (skipIfExists matched)', { pipeline: def.name, path: event.subject });
          continue;
        }

        if (trigger.skipIfAttr && this.skipBecauseAttr(trigger.skipIfAttr, await subjectAttrs())) {
          logger.debug('skipping pipeline (skipIfAttr matched)', { pipeline: def.name, path: event.subject });
          continue;
        }

        if (trigger.filter && await this.evalShell(trigger.filter, env) !== 0) continue;

        if (trigger.skipIf && await this.evalShell(trigger.skipIf, env) === 0) {
          logger.debug('skipping pipeline (skipIf matched)', { pipeline: def.name, path: event.subject });
          continue;
        }

        logger.debug('trigger matched', { pipeline: def.name, path: event.subject, event: event.type });
        await this.admitTrigger(
          def,
          event.subject,
          nodeId,
          event,
          { ...def.vars, ...trigger.vars },
          trigger.priority ?? def.options?.priority,
          event.write,
        );
        break;
      }
    }
  }

  private async handleTrigger(event: VfsTriggerEvent): Promise<void> {
    if (!this.running) return;

    // Skip pipeline-internal paths (instance/step nodes emit their own events)
    if (event.path.startsWith(this.pipelinesPath)) return;

    // The published event is slim (identity only). Resolve the node's attrs from
    // the VFS lazily — only once a definition matches on event+nodeType, and only
    // once per trigger. The node may be gone (e.g. deleted) — then attrs is empty.
    const getAttrs = this.attrsReader(event.path);
    const getTriggerWrite = this.triggerWriteReader(event);

    for (const [, def] of this.definitions) {
      const triggers = def.triggers.filter((trigger) => trigger.event === event.type && trigger.nodeType === event.nodeType);
      if (triggers.length === 0) continue;

      // Cheapest rejection first — before the node fetch and before any shell.
      // A pipeline's own steps mutate the trigger node, which re-emits `updated`
      // events that re-match; those are the bulk of what arrives here during a
      // crawl, and none of them should cost a filter evaluation. Not under
      // `coalesce: rerun`, for the reason given in `handleDomainTrigger`.
      if (!rerunsOnCoalesce(def) && await this.isSelfInflictedTrigger(def.name, event.nodeId, event.timestamp)) {
        logger.debug('skipping trigger (self-inflicted or in-flight)', { pipeline: def.name, path: event.path });
        continue;
      }

      const mimetype = String((await getAttrs()).mimetype ?? '');
      const env = {
        NODE_PATH: event.path,
        MIMETYPE: mimetype,
        NODE_TYPE: event.nodeType,
        EVENT_TYPE: event.type,
      };

      for (const trigger of triggers) {
        // Declarative checks first — they cost no process at all.
        if (trigger.match && !this.matchesTrigger(trigger.match, env)) continue;

        if (trigger.unless && this.matchesTrigger(trigger.unless, env)) {
          logger.debug('skipping pipeline (unless matched)', { pipeline: def.name, path: event.path });
          continue;
        }

        if (!trigger.allowDerived && isDerivedFile(await getAttrs())) {
          logger.debug('skipping pipeline (derived subject)', { pipeline: def.name, path: event.path });
          continue;
        }

        if (trigger.skipIfExists && await this.skipBecauseExists(trigger.skipIfExists, env)) {
          logger.debug('skipping pipeline (skipIfExists matched)', { pipeline: def.name, path: event.path });
          continue;
        }

        if (trigger.skipIfAttr && this.skipBecauseAttr(trigger.skipIfAttr, await getAttrs())) {
          logger.debug('skipping pipeline (skipIfAttr matched)', { pipeline: def.name, path: event.path });
          continue;
        }

        if (trigger.filter && await this.evalShell(trigger.filter, env) !== 0) continue;

        if (trigger.skipIf && await this.evalShell(trigger.skipIf, env) === 0) {
          logger.debug('skipping pipeline (skipIf matched)', { pipeline: def.name, path: event.path });
          continue;
        }

        logger.debug('trigger matched', { pipeline: def.name, path: event.path });
        await this.admitTrigger(
          def,
          event.path,
          event.nodeId,
          undefined,
          { ...def.vars, ...trigger.vars },
          trigger.priority ?? def.options?.priority,
          await getTriggerWrite(),
        );
        break;
      }
    }
  }

  /**
   * The write a VFS trigger stands for, looked up at most once per event. An event names the
   * record its write left; a write that changed nothing the trail keeps — the truncating open
   * that starts an upload — left none, and then it is the subject's latest record, the write
   * that gave the node its current state. Undefined when the trail has nothing for the node.
   *
   * It matters which event is first: the trigger pool keeps the first announcement's params, so
   * an upload's run would otherwise carry no cause whenever the truncation came before the content.
   */
  private triggerWriteReader(event: VfsTriggerEvent): () => Promise<AuditedWrite | undefined> {
    let read: Promise<AuditedWrite | undefined> | undefined;
    return () => {
      read ??= (async () => {
        if (event.auditId) return { auditId: event.auditId, uid: event.uid };
        try {
          const [latest] = await this.vfs.audit(ADMIN_ACCESS, { nodeId: event.nodeId, limit: 1 });
          return latest ? { auditId: latest.id, uid: latest.uid } : undefined;
        } catch {
          return undefined;
        }
      })();
      return read;
    };
  }

  /**
   * A trigger past every guard: enqueue it, unless the definition coalesces by
   * rerunning and an instance for the subject is live — then it is folded into
   * that instance instead, and `rerunIfRequested` re-announces the subject when
   * the instance ends.
   *
   * The fold and the completion race, and both sides re-read after writing so
   * neither can lose the trigger: a fold that finds the instance already
   * terminal on its second read enqueues after all, and a completion that finds
   * the mark on its own second read enqueues too. Both may happen for the same
   * arrival; the pool's dedup makes that one job.
   */
  private async admitTrigger(
    def: PipelineDef,
    triggerPath: string,
    nodeId: NodeId,
    triggerEvent?: DomainEvent,
    vars?: Record<string, string>,
    priority?: number,
    triggerWrite?: AuditedWrite,
  ): Promise<void> {
    if (rerunsOnCoalesce(def) && await this.foldIntoLiveInstance(def.name, nodeId, { triggerEvent, triggerWrite, vars, priority, at: Date.now() })) {
      logger.debug('trigger folded into a live instance (coalesce: rerun)', { pipeline: def.name, path: triggerPath });
      return;
    }

    await this.enqueueInstance(def.name, triggerPath, nodeId, triggerEvent, vars, priority, triggerWrite);
  }

  /** Record `rerun` on the subject's live instance. False when there is none to fold into. */
  private async foldIntoLiveInstance(pipelineName: string, nodeId: NodeId, rerun: PendingRerun): Promise<boolean> {
    const instancePath = join(this.pipelinesPath, 'instances', pipelineName, nodeId);

    const liveNow = async (): Promise<boolean> => {
      try {
        return isLiveInstance((await this.vfs.get<PipelineInstanceAttrs>(ADMIN_ACCESS, instancePath)).attrs.status);
      } catch {
        return false;
      }
    };

    if (!(await liveNow())) return false;

    try {
      await this.vfs.update<PipelineInstanceAttrs>(ADMIN_ACCESS, instancePath, { attrs: { rerun } });
    } catch {
      // Gone between the read and the write — replaced or removed. Nothing holds
      // the subject any more, so the trigger takes the ordinary path.
      return false;
    }

    // See admitTrigger: the instance may have ended between the read and the
    // mark, in which case its completion never saw the mark and this side owes
    // the announcement.
    return await liveNow();
  }

  /**
   * Re-announce an instance's subject if a trigger was folded into it while it
   * ran (`options.coalesce: rerun`). Called once the instance is terminal.
   */
  private async rerunIfRequested(instancePath: string): Promise<void> {
    let attrs: PipelineInstanceAttrs;
    try {
      attrs = (await this.vfs.get<PipelineInstanceAttrs>(ADMIN_ACCESS, instancePath)).attrs;
    } catch {
      return;
    }

    if (!attrs.rerun || isLiveInstance(attrs.status)) return;

    const def = this.definitions.get(attrs.pipelineName);
    if (!def || !rerunsOnCoalesce(def)) return;

    const nodeId = attrs.triggerNodeId ?? basename(instancePath);

    logger.info('re-announcing subject after a folded trigger', { pipeline: def.name, path: attrs.triggerPath });
    const { rerun } = attrs;
    await this.enqueueInstance(def.name, attrs.triggerPath, nodeId, rerun.triggerEvent, rerun.vars, rerun.priority, rerun.triggerWrite);

    // Consumed. The terminal instance is re-advanced by its own events until it
    // is replaced, and each pass would otherwise re-announce — harmless under
    // the pool's dedup, but a write per pass for nothing. A fold that lands
    // after the read above finds the instance terminal and announces itself.
    try {
      await this.vfs.update<PipelineInstanceAttrs>(ADMIN_ACCESS, instancePath, { attrs: { rerun: undefined } });
    } catch {
      // Already replaced by the run just announced.
    }
  }

  /**
   * A matched trigger becomes a pool job, not an instance.
   *
   * This is what makes a re-announced subject *free* rather than merely rare:
   * `dedupKey` is unique among a pool's non-terminal jobs, so the same
   * (pipeline, node) announced eight times is one row.
   *
   * It also gets the *unstarted* backlog into the one layer that can order it,
   * and keeps announcing work cheaper than scheduling it: creating an instance
   * is a handful of node writes, done outside the consume loop.
   */
  private async enqueueInstance(
    pipelineName: string,
    triggerPath: string,
    nodeId: NodeId,
    triggerEvent?: DomainEvent,
    vars?: Record<string, string>,
    priority?: number,
    triggerWrite?: AuditedWrite,
  ): Promise<void> {
    try {
      await this.vfs.poolAdd(ADMIN_ACCESS, this.triggerPoolPath, {
        kind: pipelineName,
        dedupKey: `${pipelineName}/${nodeId}`,
        params: { pipelineName, triggerPath, nodeId, triggerEvent, triggerWrite, vars, priority } satisfies TriggerJobParams,
        // The lane alone orders trigger jobs, so the normal lane's are all at 0. A re-add keeps
        // the higher priority, so a normal announcement lifts a bulk job waiting for the subject,
        // and `runTriggerJob` reads the run's lane off the job, not off the first announcement.
        priority: laneOffset(triggerEvent?.lane),
        // The pool keeps the earliest `availableAt` on a re-add, so the hold is
        // measured from the first announcement of a burst, never extended by it.
        delayMs: this.definitions.get(pipelineName)?.options?.debounceMs,
      });
    } catch (err) {
      // Rethrow: the consume loop nacks, so the trigger is redelivered rather
      // than silently dropped along with the work it stood for.
      logger.error('failed to enqueue trigger job', { pipeline: pipelineName, path: triggerPath, error: err });
      throw err;
    }
  }

  /**
   * Turn trigger jobs into instances, `triggerConcurrency` at a time.
   *
   * Kept inside the engine rather than in a pool worker: `advanceDAG`
   * serialises on an in-process mutex and dispatches steps on the engine's own
   * shell, so the process that creates an instance must be the one that advances
   * it. What the pool adds here is the dedup, the durability and the lease —
   * not distribution.
   */
  private async triggerClaimLoop(): Promise<void> {
    while (this.running) {
      if (this.creating.size >= this.triggerConcurrency) {
        await this.waitForTriggerSlot();
        continue;
      }

      // Do not claim work the engine has no room to start. Leaving the job
      // `ready` is not a delay, it is where the backlog is supposed to live:
      // creating the instance instead would only move it onto the heap.
      await this.waitForAdmission();
      if (!this.running) return;

      // Past the ceiling only the pipelines below their fair share may claim —
      // see `underShareKinds`. Their probes are non-blocking, so a miss here is
      // "nothing ready for them", not an abort: poll again rather than park on
      // an unfiltered claim that would admit the very pipeline holding the gate.
      const restricted = this.advanceLocks.size >= this.maxOpenInstances ? this.underShareKinds() : undefined;

      let job;
      try {
        job = await this.claimTriggerFairly(restricted);
      } catch (err) {
        if (!this.running) return;
        logger.error('trigger claim failed', { error: err });
        await this.backoff();
        continue;
      }

      if (!job) {
        // Unrestricted, null is a genuine abort — the pool never reports "nothing" that way.
        if (!this.running || !restricted) return;
        await this.backoff(ADMISSION_POLL_MS);
        continue;
      }

      this.adjustCreating(job.kind, 1);
      const work = this.runTriggerJob(job)
        .catch((err) => logger.error('trigger job error', { job: job.id, error: err }))
        .finally(() => {
          this.adjustCreating(job.kind, -1);
          this.creating.delete(work);
          this.triggerSlotFreed?.();
        });
      this.creating.add(work);
    }
  }

  /**
   * Claim one trigger from the pipeline holding the fewest admission slots.
   *
   * Trigger jobs are created at priority 0, or at the bulk lane's offset below
   * it (`enqueueInstance`), and the pool orders `eff_priority DESC, created_at
   * ASC` — so a claim takes a pipeline's bulk triggers only once it has no
   * normal one ready, and within a lane an unfiltered claim is strict global
   * FIFO. FIFO is systematically unfair in one direction: a pipeline
   * triggered by a *domain event* that an upstream step emits can only be
   * announced after that step has run on the file, so its `created_at` is
   * always later than the upstream triggers of every file queued since. Behind a backlog it is permanently last, and the library
   * stays half-processed until the whole upstream backlog clears.
   *
   * Round-robin claims alone are fair only at the instant a claim happens. A
   * slow pipeline keeps each admitted instance open longer, so equal claim
   * rates let it ratchet up to the whole open-instance ceiling while a fast
   * pipeline repeatedly returns its slots.
   *
   * So: count the open and currently-creating instances per pipeline, probe the
   * least-loaded pipelines first, and retain the round-robin cursor as the tie
   * break between equal loads. That ordering applies only once half the ceiling
   * is open. Below it open slots are not what is scarce, the claim rate is, and
   * least-loaded would hand nearly every claim to the pipelines whose instances
   * finish at once (always at load 0), so a pipeline waiting on a slow pool is
   * admitted a few times an hour while its pool worker idles (ein/core#734).
   * There the cursor alone rotates, one claim per pipeline with work. A sole
   * backlog may still borrow the full ceiling; as soon as another pipeline has ready work, its lower load gives it every
   * freed slot until the occupancy is balanced. The probes remain non-blocking:
   * `claim()` runs its `tryClaim` and returns that result directly when no
   * AbortSignal is passed, so omitting the signal is what makes these probes
   * non-blocking — with a signal they would park on the first empty kind
   * forever. A single-kind filter is also the fast index path (a scalar equality
   * lets the planner stop at the first row) rather than a pool-wide walk.
   *
   * The ordinary rotation retains one unfiltered candidate so a job whose
   * definition was removed is still reached under load. It is assigned the
   * highest current pipeline load: every less-loaded definition gets a direct
   * probe first, so the wildcard cannot let an incumbent jump a pipeline that
   * is owed admission. A fully empty rotation then falls through to a blocking
   * unfiltered claim. `null` therefore remains a genuine abort, never a report
   * that no job happened to be ready.
   */
  private async claimTriggerFairly(restricted?: string[]): Promise<PoolJob | null> {
    // A reservation is a first look, not an exclusive partition. If no entry
    // job is ready, the ordinary all-pipeline rotation uses the claim instead;
    // conversely, entry work may still win one of the unreserved fair claims.
    // This preserves the existing anti-starvation contract for every pipeline
    // while guaranteeing metadata ingress a configured share under backlog.
    this.entryAdmissionCredit += this.entryAdmissionPercent;
    if (this.entryAdmissionCredit >= 100) {
      this.entryAdmissionCredit -= 100;
      const entryJob = await this.tryClaimEntryTrigger(restricted);
      if (entryJob) return entryJob;
    }

    const kinds = restricted ?? [...this.definitions.keys()];
    // The wildcard and the blocking fallback may return any kind; restricted,
    // that would hand the ceiling's holder another slot.
    const claimed = await this.tryClaimLeastLoaded(kinds, this.triggerCursor, !restricted);
    if (claimed) {
      this.triggerCursor = claimed.nextCursor;
      return claimed.job;
    }
    if (restricted) return null;

    return await this.vfs.poolClaim(ADMIN_ACCESS, this.triggerPoolPath, {
      owner: this.triggerOwner,
      leaseMs: TRIGGER_LEASE_MS,
    }, this.abort.signal);
  }

  /** Non-blocking round-robin claim across declared entry-point pipelines. */
  private async tryClaimEntryTrigger(restricted?: string[]): Promise<PoolJob | null> {
    const kinds = [...this.definitions.values()]
      .filter((definition) => Boolean(definition.options?.entryPoint))
      .map((definition) => definition.name)
      .filter((name) => !restricted || restricted.includes(name));

    const claimed = await this.tryClaimLeastLoaded(kinds, this.entryTriggerCursor);
    if (claimed) {
      this.entryTriggerCursor = claimed.nextCursor;
      return claimed.job;
    }

    return null;
  }

  /**
   * Non-blocking probes ordered by current admission occupancy, with the cursor
   * preserving round-robin order between equally loaded pipelines.
   */
  private async tryClaimLeastLoaded(
    kinds: string[],
    cursor: number,
    includeWildcard = false,
  ): Promise<{ job: PoolJob; nextCursor: number } | null> {
    if (kinds.length === 0 && !includeWildcard) return null;

    const loads = this.advanceLocks.size >= this.maxOpenInstances * LOAD_ORDER_FROM ? this.pipelineAdmissionLoads(kinds) : new Map<string, number>();
    const length = kinds.length + (includeWildcard ? 1 : 0);
    const maxLoad = Math.max(0, ...loads.values());
    const candidates: Array<{ kind: string | null; index: number; load: number; turn: number }> = kinds.map((kind, index) => ({
      kind,
      index,
      load: loads.get(kind) ?? 0,
      turn: (index - cursor + length) % length,
    }));
    if (includeWildcard) {
      candidates.push({
        kind: null,
        index: kinds.length,
        // Never let an unfiltered claim bypass a less-loaded pipeline: it may
        // return any kind, including the current admission hog.
        load: maxLoad,
        turn: (kinds.length - cursor + length) % length,
      });
    }
    candidates.sort((a, b) => a.load - b.load || a.turn - b.turn);

    for (const candidate of candidates) {
      const job = await this.vfs.poolClaim(ADMIN_ACCESS, this.triggerPoolPath, {
        owner: this.triggerOwner,
        kinds: candidate.kind === null ? undefined : [candidate.kind],
        leaseMs: TRIGGER_LEASE_MS,
      });
      if (job) return { job, nextCursor: (candidate.index + 1) % length };
    }

    return null;
  }

  /** Open instance locks plus trigger claims still finishing creation. */
  private pipelineAdmissionLoads(kinds: string[]): Map<string, number> {
    const loads = new Map(kinds.map((kind) => [kind, this.creatingByPipeline.get(kind) ?? 0]));
    const prefix = join(this.pipelinesPath, 'instances') + '/';

    for (const path of this.advanceLocks.keys()) {
      if (!path.startsWith(prefix)) continue;
      const pipeline = path.slice(prefix.length).split('/')[0];
      if (loads.has(pipeline)) loads.set(pipeline, loads.get(pipeline)! + 1);
    }

    return loads;
  }

  private adjustCreating(pipeline: string, delta: 1 | -1): void {
    const next = (this.creatingByPipeline.get(pipeline) ?? 0) + delta;
    if (next > 0) this.creatingByPipeline.set(pipeline, next);
    else this.creatingByPipeline.delete(pipeline);
  }

  /**
   * Whether either half of the admission gate is full. See the two limits for why they differ.
   *
   * The open-instance half is not a wall for every pipeline. The least-loaded ordering in
   * `tryClaimLeastLoaded` is fair only for slots that come free, and a pipeline whose steps all
   * wait on a slow pool frees none, so it can hold the whole ceiling while another pipeline
   * runs one instance at a time. So past the ceiling a pipeline may still be admitted while it
   * holds less than its fair share (`underShareKinds`), bounded by a hard cap of twice the
   * ceiling that keeps `kickOpenInstances`' O(open) sweep within a known factor.
   */
  private get gateClosed(): boolean {
    if (this.inFlight.size >= this.maxAdmittedSteps) return true;
    if (this.advanceLocks.size < this.maxOpenInstances) return false;
    return this.underShareKinds().length === 0;
  }

  /**
   * The pipelines still owed admission while the open-instance ceiling is held: each may hold
   * an equal share of the ceiling regardless of how much a slower one has borrowed. Empty once
   * every pipeline has its share or the hard cap is reached.
   */
  private underShareKinds(): string[] {
    if (this.advanceLocks.size >= this.maxOpenInstances * OPEN_INSTANCE_HARD_CAP_FACTOR) return [];
    const kinds = [...this.definitions.keys()];
    if (kinds.length === 0) return [];
    const share = Math.max(1, Math.ceil(this.maxOpenInstances / kinds.length));
    const loads = this.pipelineAdmissionLoads(kinds);
    return kinds.filter((kind) => (loads.get(kind) ?? 0) < share);
  }

  /**
   * Park until the engine has room to admit more work.
   *
   * Polled rather than notified on purpose: a missed wakeup here stalls the
   * pipeline silently, and the condition is checked only when already saturated,
   * where 100 ms of granularity is nothing against step execution times.
   */
  private async waitForAdmission(strict = false): Promise<void> {
    const closed = () => strict ? this.inFlight.size >= this.maxAdmittedSteps || this.advanceLocks.size >= this.maxOpenInstances : this.gateClosed;
    while (this.running && closed()) {
      await this.backoff(ADMISSION_POLL_MS);

      // An instance leaves `advanceLocks` only when an advance sees it terminal,
      // and nothing periodically advances one. A `waiting` step whose pool job
      // was lost, or an advance that threw, would therefore hold its slot for
      // good — and unlike a dispatched step, which a timeout always ends, that
      // slot never comes back and the gate wedges shut. So when instances are
      // what is holding it, re-advance them: it is idempotent, it drops the lock
      // of one that is already finished and re-adds a missing pool job, so a
      // stuck slot heals rather than accumulating.
      //
      // Rate-limited on a timestamp rather than on loop iterations because both
      // the trigger loop and recover() park here at the same time.
      if (this.advanceLocks.size >= this.maxOpenInstances && Date.now() - this.lastKickAt >= this.stuckSweepMs) {
        this.kickOpenInstances();
      }
    }
  }

  /**
   * Re-advance instances that have stayed open across a whole sweep interval.
   *
   * The orphan repair in `advanceDAGLocked` — a pooled step marked `running` or `waiting` whose
   * pool job no longer exists — only runs when something advances the instance, and nothing
   * advances one on its own. So the sweep runs on its own clock, and a saturated gate makes
   * `waitForAdmission` run it sooner as well. Both paths go through the same rate limit.
   */
  private async stuckSweepLoop(): Promise<void> {
    while (this.running) {
      await this.backoff(this.stuckSweepMs);
      if (!this.running) return;
      if (Date.now() - this.lastKickAt < this.stuckSweepMs) continue;
      try {
        this.kickOpenInstances();
      } catch (err) {
        logger.error('stuck sweep failed', { error: err });
      }
    }
  }

  /**
   * Re-advance the instances that stayed open since the last pass, coalesced with the advances
   * the node subscription schedules.
   *
   * Reports on the gate only when it is held — `maxOpenInstances` open. Below the cap an
   * instance open for long holds nothing back: a step runs for as long as it needs
   * (ein/core#358).
   *
   * At the cap, warns only when *nothing* moved since the last pass — under a real backlog the
   * set turns over constantly, so the same instances still being open a sweep later is the
   * part worth a line. "Nothing moved" means the set is static, not merely that no new instance
   * was admitted: a saturated gate whose completions have not been refilled yet only shrinks,
   * and that is a draining engine. Comparing against the previous size as well tells the two
   * apart: a wedged gate repeats the same count, a draining one does not.
   */
  private kickOpenInstances(): void {
    const open = [...this.advanceLocks.keys()];
    const unmoved = this.lastKickOpen.filter((path) => this.advanceLocks.has(path));
    const previousSize = this.lastKickOpen.length;
    this.lastKickAt = Date.now();
    this.lastKickOpen = open;

    const nothingLeft = unmoved.length === open.length;
    const nothingFinished = open.length === previousSize;

    if (open.length < this.maxOpenInstances) {
      logger.debug('re-advancing open instances', { instances: open.length });
    } else if (nothingLeft && nothingFinished) {
      logger.warn('admission gate held by instances that are not moving', { instances: open.length, sample: open.slice(0, 5) });
    } else if (nothingLeft) {
      logger.info('admission gate saturated, draining', { instances: open.length, finished: previousSize - open.length });
    } else {
      logger.debug('re-advancing open instances at the admission cap', { instances: open.length });
    }

    // Only what was already open at the previous sweep. A healthy instance turns over between
    // sweeps and needs no help, so re-advancing everything would put an O(open) burst of reads
    // on the store every minute to repair the handful that are actually stuck. When the gate is
    // wedged this is the whole set anyway.
    const stuck = unmoved.length > 0 ? unmoved : (this.advanceLocks.size >= this.maxOpenInstances ? open : []);
    for (const path of stuck) this.schedule(path, () => this.advanceDAG(path));
  }

  private waitForTriggerSlot(): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        this.triggerSlotFreed = undefined;
        this.abort.signal.removeEventListener('abort', done);
        resolve();
      };

      this.triggerSlotFreed = done;
      this.abort.signal.addEventListener('abort', done, { once: true });
    });
  }

  private async runTriggerJob(job: PoolJob): Promise<void> {
    const jobId = job.id;
    const params = job.params as TriggerJobParams | null;
    if (!params?.pipelineName || !params.triggerPath) {
      await this.vfs.poolFail(ADMIN_ACCESS, this.triggerPoolPath, jobId, this.triggerOwner, 'malformed trigger job');
      return;
    }

    // Re-read the definition at claim time rather than trusting the one that
    // matched: a job can sit in the pool across a definition reload, and the
    // instance should be built from the steps that exist now.
    const def = this.definitions.get(params.pipelineName);
    if (!def) {
      logger.warn('trigger job for an undefined pipeline, dropping', { pipeline: params.pipelineName });
      await this.vfs.poolComplete(ADMIN_ACCESS, this.triggerPoolPath, jobId, this.triggerOwner, { skipped: 'undefined' });
      return;
    }

    try {
      logger.info('creating instance', { pipeline: def.name, path: params.triggerPath });
      await this.createInstance(
        def,
        params.triggerPath,
        params.triggerEvent,
        params.nodeId,
        params.vars,
        params.priority,
        params.triggerWrite,
        // The params are the first announcement's; the job's priority is its lane's offset,
        // lifted to the normal lane's when a normal announcement of the subject came after.
        job.priority < 0 ? params.triggerEvent?.lane : undefined,
      );
      await this.vfs.poolComplete(ADMIN_ACCESS, this.triggerPoolPath, jobId, this.triggerOwner);
    } catch (err) {
      await this.vfs.poolFail(
        ADMIN_ACCESS,
        this.triggerPoolPath,
        jobId,
        this.triggerOwner,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * True if a trigger for (pipeline, triggerPath) at `eventTs` was caused by a
   * pipeline instance rather than an independent change. A step mutating the
   * trigger node re-emits events whose timestamps fall inside the instance's
   * `[startedAt, completedAt]` window (all step writes finish before the instance
   * is marked completed); `SELF_TRIGGER_GRACE_MS` covers async event emission and
   * clock skew just past completion. A running instance suppresses regardless of
   * timestamp (the current DAG owns the node). An independent change after the
   * window (e.g. the user edits the file later) has `eventTs` past the window and
   * is not suppressed — it starts a fresh instance (replacing the prior one, via
   * one-per-node).
   *
   * One direct get, because the instance is named after its trigger node.
   */
  private async isSelfInflictedTrigger(
    pipelineName: string,
    nodeId: NodeId,
    eventTs: number,
  ): Promise<boolean> {
    const instancePath = join(this.pipelinesPath, 'instances', pipelineName, nodeId);

    let attrs: PipelineInstanceAttrs;
    try {
      attrs = (await this.vfs.get<PipelineInstanceAttrs>(ADMIN_ACCESS, instancePath)).attrs;
    } catch {
      return false;
    }

    if (isLiveInstance(attrs.status)) return true;

    const windowEnd = (attrs.completedAt ?? Date.now()) + SELF_TRIGGER_GRACE_MS;

    return eventTs >= attrs.startedAt && eventTs <= windowEnd;
  }

  /** The node at a path, or undefined if it is gone. */
  private async resolveNode(path: string): Promise<Node | undefined> {
    try {
      return await this.vfs.get(ADMIN_ACCESS, path);
    } catch {
      return undefined;
    }
  }

  /**
   * Delete the prior instance for a (pipeline, trigger node) so at most one
   * exists per node. Only touches a terminal instance — a still-running one is
   * handled by the trigger dedup, so we never yank it out here.
   *
   * @returns true if the name is free to create. A running prior instance and a
   * failed unlink both return false: the caller must not create over a subtree
   * that is still there, or it ends up appending steps to the old instance.
   */
  private async removePriorInstance(
    pipelineInstancesPath: string,
    instanceId: string,
  ): Promise<boolean> {
    const path = join(pipelineInstancesPath, instanceId);

    try {
      const node = await this.vfs.get<PipelineInstanceAttrs>(ADMIN_ACCESS, path);
      if (isLiveInstance(node.attrs.status)) {
        logger.warn('prior instance still live, not replacing it', { path, status: node.attrs.status });
        return false;
      }
    } catch {
      return true; // no prior instance
    }

    try {
      await this.vfs.unlink(ADMIN_ACCESS, path, pipelineInstancesPath, { recursive: true });
      this.advanceLocks.delete(path);
      return true;
    } catch (err) {
      logger.warn('failed to remove prior instance', { path, error: err });
      return false;
    }
  }

  async createInstance(
    def: PipelineDef,
    triggerPath: string,
    triggerEvent?: DomainEvent,
    nodeId?: NodeId,
    vars?: Record<string, string>,
    priority?: number,
    triggerWrite?: AuditedWrite,
    lane?: Lane,
  ): Promise<string> {
    // The instance is named after its trigger node, which makes one-per-node
    // structural and every later lookup a direct get.
    const trigger = await this.resolveNode(triggerPath);
    const instanceId = nodeId ?? trigger?.id;

    if (!instanceId) {
      logger.warn('skipping instance for an unidentifiable node', { pipeline: def.name, triggerPath });
      return '';
    }

    const instancesPath = join(this.pipelinesPath, 'instances');
    const pipelineInstancesPath = join(instancesPath, def.name);
    const instancePath = join(pipelineInstancesPath, instanceId);

    await this.vfs.ensure(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, instancesPath, def.name);
    // One-per-node: drop any prior instance for this node so re-uploads/re-index
    // replace instead of accumulating. The trigger dedup already covers a running
    // one, so this only clears terminal history.
    if (!(await this.removePriorInstance(pipelineInstancesPath, instanceId))) return '';
    // The instance node, `steps/` and every step in one transaction, so no
    // reader — the advance this create's own event schedules included — can see
    // an instance that has no steps yet.
    await this.vfs.createTree(ADMIN_ACCESS, pipelineInstancesPath, [
      instanceTree(instanceId, {
        pipelineName: def.name,
        triggerPath,
        triggerNodeId: instanceId,
        triggerCreator: trigger?.id === instanceId ? trigger.props.birthtime.uid : undefined,
        // Nothing executes yet: the advance flips it to 'running' once a step is on a core.
        status: 'queued',
        startedAt: Date.now(),
        triggerEvent,
        triggerWrite,
        // Trigger-specific overrides were resolved before this job entered the
        // pool, so a delayed claim retains the event's intended run mode.
        vars: Object.keys(vars ?? def.vars ?? {}).length > 0 ? (vars ?? def.vars) : undefined,
        priority: priority ?? def.options?.priority,
        lane,
      }, def),
    ]);

    logger.info('created pipeline instance', { pipeline: def.name, instance: instanceId, triggerPath });

    await this.advanceDAG(instancePath);
    return instanceId;
  }

  /**
   * Advance the DAG, serialized per instance so concurrent step completions can't
   * read the same step as 'pending' and double-dispatch it.
   */
  async advanceDAG(instancePath: string): Promise<void> {
    let mutex = this.advanceLocks.get(instancePath);
    if (!mutex) {
      mutex = new Mutex();
      this.advanceLocks.set(instancePath, mutex);
    }
    const terminal = await mutex.withLock(() => this.advanceDAGLocked(instancePath));
    // Drop the lock entry once the instance is finished (bounds the map).
    if (terminal) {
      this.advanceLocks.delete(instancePath);
      await this.rerunIfRequested(instancePath);
    }
  }

  /** @returns true if the instance is finished (or gone) and its lock can be dropped. */
  private async advanceDAGLocked(instancePath: string): Promise<boolean> {
    const stepsPath = join(instancePath, 'steps');

    // Read before the steps, so the empty-steps case below can date the
    // instance. Nothing else about the order matters.
    let instanceAttrs: PipelineInstanceAttrs;
    try {
      const node = await this.vfs.get<PipelineInstanceAttrs>(ADMIN_ACCESS, instancePath);
      instanceAttrs = node.attrs;
    } catch {
      return true;
    }

    if (!isLiveInstance(instanceAttrs.status)) return true;

    let steps;
    try {
      steps = await this.vfs.children<PipelineStepAttrs>(ADMIN_ACCESS, stepsPath);
    } catch {
      return true;
    }

    // No steps means the instance is not done — it is unbuilt. A definition
    // with no steps cannot exist: parseSteps rejects it, and both creation paths
    // write the instance and its steps in one transaction (`vfs.createTree`).
    // What is left here is an instance nobody finished building — a hand-made
    // node, or a creation that failed outright. Waiting on steps that are never
    // coming keeps it live, and therefore keeps an admission slot, for good.
    // Past the grace window, fail it and free the slot.
    if (steps.length === 0) {
      if (Date.now() - instanceAttrs.startedAt < EMPTY_INSTANCE_GRACE_MS) return false;

      if (!await this.writeInstanceIfStill(instancePath, instanceAttrs.status, { status: 'failed', completedAt: Date.now() })) return false;
      logger.error('pipeline instance never got its steps, failing it', { instance: instancePath });
      await this.emitLifecycle('failed', instancePath, instanceAttrs, new Map());
      return true;
    }

    // The node this instance exists for has to still be there, and has to still
    // be the same node. A pooled step re-checks it when a worker claims the job;
    // this covers inline steps, which would otherwise run on against a deleted
    // path, and the first to write a child would rebuild every missing ancestor
    // as a `directory` (`mknode -p`). An instance whose steps have all ended has nothing left
    // to run against the path; its last step may have removed the node on purpose (a zip
    // expanded, then deleted), and it ends as its steps did — unless a step already ended for
    // want of the node, which is the instance's subject vanishing, not its work removing it.
    const ended = steps.every((step) => step.node.attrs.status === 'completed' || step.node.attrs.status === 'failed' || step.node.attrs.status === 'skipped');
    const vanished = steps.some((step) => step.node.attrs.status === 'skipped' && step.node.attrs.error === TARGET_MISSING);
    if ((!ended || vanished) && !await this.subjectIsIntact(instanceAttrs)) {
      await this.cancelVanishedInstance(instancePath, stepsPath, steps);
      logger.info('cancelled instance, its node is gone', {
        instance: instancePath,
        path: instanceAttrs.triggerPath,
      });
      return true;
    }

    const stepMap = new Map(steps.map((s) => [s.name, s.node.attrs]));
    // An event-triggered instance passes the fact through to its steps as
    // `$EVENT_*`, so a condition can test what the trigger already knows instead
    // of shelling back to the node. VFS-triggered instances get only $NODE_PATH —
    // anything else they read from the node, gated by dependsOn. Either way the
    // engine stays free of domain attrs.
    //
    // The instance's own `vars` go underneath: they are declared by the
    // definition and may be overridden per run (`--var FORCE=-f`), but they can
    // never shadow a name the trigger owns.
    const envVars = {
      ...instanceAttrs.vars,
      ...(instanceAttrs.triggerEvent ? eventEnv(instanceAttrs.triggerEvent) : { NODE_PATH: instanceAttrs.triggerPath }),
    };

    // Step commands get the same names substituted in, shell-quoted so a path or
    // a caption with spaces/quotes survives. An empty value substitutes to
    // nothing at all — `''` is a word, and an unset optional flag must not
    // become an empty argument. envVars stays raw for evalShell, which exports
    // its own quoted env — quoting there too would double-quote.
    const quotedEnv = Object.fromEntries(
      Object.entries(envVars).map(([key, value]) => [key, value === '' ? '' : shq(value)]),
    );
    const instancePriority = instanceAttrs.priority ?? this.definitionPriority(instancePath);
    // Every job of a run in the bulk lane, pooled or on the engine's semaphore, ranks this far down.
    const offset = laneOffset(instanceAttrs.lane);

    let anyQueued = false;
    let anyFailed = false;
    let anyPending = false;
    // Executing *now*: a step the engine dispatched inline, or a pooled step a worker has
    // claimed and moved to 'running'. Distinct from `anyWaiting` below, which is work that
    // exists but is sitting in a queue — see PipelineStatus.
    let anyRunning = false;
    let anyWaiting = false;

    for (const step of steps) {
      const attrs = step.node.attrs;

      switch (attrs.status) {
        case 'waiting':
          anyWaiting = true;
          // Reconcile: a pooled step is only in flight if its job still exists.
          // The step and the job are written separately, so a crash between the
          // two — or a job dropped by hand — leaves a step that no worker will
          // ever pick up. The add is keyed on the step path and upserts, so
          // re-adding restores it and is a no-op when the job is already there.
          if (attrs.pool) {
            await this.reconcilePoolJob(instancePath, stepsPath, step.name, attrs, quotedEnv, instancePriority, offset);
          }
          continue;
        case 'queued':
        case 'running':
          // 'queued' is dispatched-but-parked and 'running' is on a core; both are live, and
          // only the second is execution. The pooled repair below applies to either, because a
          // worker that died leaves its step in whichever it had reached.
          // Same reconciliation as 'waiting' above, and for the same reason —
          // only the repair differs: a step whose worker died goes back to
          // 'pending' when its job went with it, and to 'waiting' when the
          // pool's sweep requeued the job (`repairStartedPooledStep`).
          if (attrs.pool) {
            const repaired = await this.repairStartedPooledStep(instancePath, stepsPath, step.name, attrs.pool);
            if (repaired === 'pending') {
              stepMap.set(step.name, { ...attrs, status: 'pending' });
              anyQueued = true;
              continue;
            }
            if (repaired === 'waiting') {
              stepMap.set(step.name, { ...attrs, status: 'waiting' });
              anyWaiting = true;
              continue;
            }
          }
          if (attrs.status === 'running') anyRunning = true;
          else anyWaiting = true;
          continue;
        case 'completed':
        case 'skipped':
          continue;
        case 'failed':
          anyFailed = true;
          continue;
      }

      // Status is 'pending' — check dependencies
      const depsOk = attrs.dependsOn.every((dep) => {
        const depStatus = stepMap.get(dep)?.status;
        return depStatus === 'completed' || depStatus === 'skipped';
      });

      if (!depsOk) {
        // If any dep failed, cascade the failure so the pipeline can resolve
        const failedDep = attrs.dependsOn.find((dep) => stepMap.get(dep)?.status === 'failed');
        if (failedDep) {
          await this.vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, join(stepsPath, step.name), {
            attrs: { status: 'failed', error: `dependency ${failedDep} failed`, completedAt: Date.now() },
          });
          stepMap.set(step.name, { ...attrs, status: 'failed' });
          anyFailed = true;
          logger.info('step failed (dependency failed)', { step: step.name, dep: failedDep, instance: instancePath });
          continue;
        }
        anyPending = true;
        continue;
      }

      // Handed back by a run that could not do it yet: not before its time.
      if (attrs.notBefore && attrs.notBefore > Date.now()) {
        this.wakeAt(instancePath, attrs.notBefore);
        anyPending = true;
        continue;
      }

      // Evaluate condition
      if (attrs.condition) {
        const condResult = await this.evalShell(attrs.condition, envVars);
        if (condResult !== 0) {
          // Skip this step
          await this.vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, join(stepsPath, step.name), {
            attrs: { status: 'skipped', completedAt: Date.now() },
          });
          stepMap.set(step.name, { ...attrs, status: 'skipped' });
          logger.info('step skipped (condition false)', { step: step.name, instance: instancePath });
          // Re-check — skipping may unblock other steps
          anyQueued = true;
          continue;
        }
      }

      // Ready to run: pool it, or mark it queued (counting the attempt) and
      // dispatch it without awaiting, so the loop keeps starting other ready
      // steps. The semaphore inside dispatchStep is the actual throttle.
      const command = this.substitute(attrs.command, quotedEnv);

      // Pooled step: mark it 'waiting' and hand the job to the pool, which owns
      // scheduling *and* attempts from here. A pool-side retry never comes back
      // through the engine — the job returns to 'ready' with backoff while the
      // step stays 'waiting' — so `attrs.attempts` is not touched here; the
      // worker copies the pool's count onto the step when it claims the job.
      // `startedAt` is left for that claim too: it times execution, and
      // `waitingSince` times the wait in the pool.
      //
      // `add` is keyed on the step path and upserts, which is what makes this
      // safe to re-run on every advance: a step left 'waiting' with no job
      // behind it (engine killed between the two writes) heals on the next pass
      // instead of stalling forever, and a duplicate advance cannot double-book.
      if (attrs.pool) {
        await this.vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, join(stepsPath, step.name), {
          attrs: { status: 'waiting', startedAt: undefined, waitingSince: Date.now() },
        });
        if (await this.stepOutlivedInstance(instancePath, join(stepsPath, step.name))) return true;
        stepMap.set(step.name, { ...attrs, status: 'waiting' });
        anyWaiting = true;

        await this.addPoolJob(attrs.pool, join(stepsPath, step.name), {
          kind: attrs.kind ?? step.name,
          priority: (attrs.priority ?? instancePriority) + offset,
          requires: attrs.requires,
          exclusive: attrs.exclusive,
          maxAttempts: attrs.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
          // A step put back to pending by orphan repair keeps the runs it had, so one that kills
          // its worker every time runs out of attempts rather than looping; a fresh step has none.
          attempts: attrs.attempts,
          params: { instancePath, stepName: step.name, command, attribution: stepAttribution(basename(instancePath), instanceAttrs) } satisfies PoolJobParams,
        });

        logger.info('step pooled', { step: step.name, pool: attrs.pool, instance: instancePath });
        continue;
      }

      // 'queued', not 'running': `dispatchStep` parks on the concurrency semaphore and only
      // then executes, so a step marked running here can sit for minutes without a core.
      // `startedAt` is set with the flip to 'running' for the same reason — it is meant to
      // measure execution, not the wait for a permit.
      const attempt = (attrs.attempts ?? 0) + 1;
      await this.vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, join(stepsPath, step.name), {
        attrs: { status: 'queued', attempts: attempt, notBefore: undefined },
      });
      if (await this.stepOutlivedInstance(instancePath, join(stepsPath, step.name))) return true;
      stepMap.set(step.name, { ...attrs, status: 'queued' });
      anyWaiting = true;
      const attribution = stepAttribution(basename(instancePath), instanceAttrs);
      this.trackDispatch({ instancePath, stepName: step.name, stepId: step.node.id, attempt, attribution }, command, instancePriority + offset);
      logger.info('step dispatched', { step: step.name, instance: instancePath });
    }

    // If a skip happened, re-run to unblock downstream (already inside the lock)
    if (anyQueued && !anyRunning && !anyWaiting) {
      return await this.advanceDAGLocked(instancePath);
    }

    // Determine instance final state
    if (!anyPending && !anyRunning && !anyQueued && !anyWaiting) {
      const finalStatus = anyFailed ? 'failed' : 'completed';
      if (!await this.writeInstanceIfStill(instancePath, instanceAttrs.status, { status: finalStatus, completedAt: Date.now() })) return false;
      logger.info('pipeline instance finished', { instance: instancePath, status: finalStatus });
      await this.emitLifecycle(finalStatus, instancePath, instanceAttrs, stepMap);
      return true;
    }

    // Still live. Which of the two live states depends on whether anything is on a core right
    // now — written only on a change, because this runs on every advance and an instance that
    // sits queued behind a hundred others would otherwise rewrite its own node each pass.
    const live: PipelineStatus = anyRunning ? 'running' : 'queued';
    if (instanceAttrs.status !== live) {
      // `executingSince` rides the same write: it is only meaningful while running, and
      // clearing it on the way back to queued is what stops a later advance reporting the
      // elapsed time of a run that has already ended.
      await this.writeInstanceIfStill(instancePath, instanceAttrs.status, { status: live, executingSince: live === 'running' ? Date.now() : undefined });
    }

    return false; // still has pending, queued or running work
  }

  /**
   * Write the instance, as long as its status is still `read`, the one this advance decided on.
   *
   * `pipeline cancel` writes the instance without this engine's lock, so an advance that read it
   * live can come to write after the cancel has. Unconditionally, the flip between `queued` and
   * `running` would put the cancelled instance back to live, and the next advance, finding every
   * step skipped, would finish it `completed` (ein/core#722). Whoever changed the status keeps
   * it; their write's event brings the next advance, which reads what they wrote.
   *
   * `updateMany` for its `guard`, which it asks of the node under the lock it writes it under.
   *
   * @returns false, with nothing written, when the status had changed.
   */
  private async writeInstanceIfStill(
    instancePath: string,
    read: PipelineStatus,
    attrs: NodeAttrsUpdate<PipelineInstanceAttrs>,
  ): Promise<boolean> {
    const [result] = await this.vfs.updateMany<PipelineInstanceAttrs>(ADMIN_ACCESS, [instancePath], {
      attrs,
      guard: (node) => {
        if (node.attrs.status !== read) throw new NodeVersionConflictError(node.id);
      },
    });
    if (result.status === 'fulfilled') return true;
    if (result.reason instanceof NodeVersionConflictError) return false;
    throw result.reason;
  }

  /**
   * After a step was written 'waiting' or 'queued': true, with the step put back
   * to 'skipped', if its instance is no longer live.
   *
   * `pipeline cancel` writes the instance and its steps without this engine's
   * lock, so an advance can read a step 'pending', lose the race to the cancel,
   * and write it live again under a cancelled instance — where nothing would
   * ever finish it. The cancel writes the instance before it reads the steps;
   * re-reading the instance after the step write is the other half, so one of
   * the two always sees the other's write (ein/core#483).
   */
  private async stepOutlivedInstance(instancePath: string, stepPath: string): Promise<boolean> {
    try {
      const instance = await this.vfs.get<PipelineInstanceAttrs>(ADMIN_ACCESS, instancePath);
      if (isLiveInstance(instance.attrs.status)) return false;
    } catch {
      return true; // Removed; the step went with it.
    }

    await this.vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, stepPath, {
      attrs: { status: 'skipped', completedAt: Date.now() },
    });
    logger.info('step written live after its instance ended, skipped', { step: stepPath, instance: instancePath });
    return true;
  }

  /**
   * True if this instance's subject node is still there, and is still the same
   * node.
   *
   * One get. Identity only when the instance recorded it: one built by hand, as
   * `pipeline-repair`'s fixtures are, can only be judged on existence.
   */
  private async subjectIsIntact(instance: PipelineInstanceAttrs): Promise<boolean> {
    let id: NodeId;

    try {
      id = (await this.vfs.get(ADMIN_ACCESS, instance.triggerPath)).id;
    } catch {
      return false;
    }

    return instance.triggerNodeId === undefined || id === instance.triggerNodeId;
  }

  /** True if the instance at `instancePath` is there and its subject node is not. */
  private async subjectVanished(instancePath: string): Promise<boolean> {
    let instance: PipelineInstanceAttrs;
    try {
      instance = (await this.vfs.get<PipelineInstanceAttrs>(ADMIN_ACCESS, instancePath)).attrs;
    } catch {
      return false;
    }

    return !await this.subjectIsIntact(instance);
  }

  /**
   * Cancel an instance whose node is gone: every step that could still run is
   * marked skipped, and any pool job behind one is dropped.
   *
   * Marking a 'waiting' step skipped is already the cancel a worker honours when
   * it claims the job, but the job stays claimable until then and holds pool
   * capacity meanwhile — so it goes explicitly too, the same pairing
   * `pipeline remove` uses.
   *
   * No lifecycle event: `pipeline.instance.completed` is what downstream
   * pipelines fan out on, and there is no longer a node for them to fan out to.
   */
  private async cancelVanishedInstance(
    instancePath: string,
    stepsPath: string,
    steps: NodeChildEntry<PipelineStepAttrs>[],
  ): Promise<void> {
    for (const step of steps) {
      const attrs = step.node.attrs;
      const live = attrs.status === 'pending' || attrs.status === 'queued' ||
        attrs.status === 'waiting' || attrs.status === 'running';
      if (!live) continue;

      await this.vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, join(stepsPath, step.name), {
        attrs: { status: 'skipped', completedAt: Date.now(), error: TARGET_MISSING },
      });

      if (!attrs.pool) continue;

      try {
        await this.vfs.poolCancel(ADMIN_ACCESS, join(this.poolsRoot, attrs.pool), { dedupKey: join(stepsPath, step.name) });
      } catch {
        // Pool or job already gone — nothing to drop.
      }
    }

    await this.vfs.update<PipelineInstanceAttrs>(ADMIN_ACCESS, instancePath, {
      attrs: { status: 'cancelled', completedAt: Date.now() },
    });
  }

  /** Wrap a step execution, tracking it in `inFlight` so stop() can await it. */
  private trackDispatch(ticket: DispatchTicket, command: string, priority: number): void {
    const p = this.dispatchStep(ticket, command, priority)
      .catch((err) => logger.error('step dispatch failed', { step: ticket.stepName, error: err }));
    this.inFlight.add(p);
    p.finally(() => this.inFlight.delete(p));
  }

  /**
   * Priority of the pipeline owning `instancePath` (`<pipelinesPath>/instances/<pipeline>/<id>`).
   * Unknown pipelines and definitions without `options.priority` sit at 0.
   */
  private definitionPriority(instancePath: string): number {
    return this.definitions.get(this.instancePipelineName(instancePath))?.options?.priority ?? 0;
  }

  /** Run one step behind the concurrency semaphore, then advance the DAG. */
  private async dispatchStep(ticket: DispatchTicket, command: string, priority: number): Promise<void> {
    const { instancePath, stepName } = ticket;
    // parks here when at the cap — this is the backpressure. Priority decides which
    // parked step gets the next freed permit, so a flood of low-priority instances
    // cannot starve a higher-priority pipeline purely by arriving first.
    await this.sem.acquire(priority);
    const hangUp = new AbortController();
    try {
      if (!this.running) return; // stopped while parked — leave 'queued' for recovery

      // The park can outlast what it was for: the instance cancelled (its step now 'skipped'),
      // or replaced by a new one for the same node, whose step sits at the same path with its
      // own dispatch on the way. Either way this one has nothing left to run or to advance.
      const stale = await this.staleDispatch(ticket);
      if (stale) {
        logger.info('dropped stale dispatch', { step: stepName, instance: instancePath, reason: stale });
        return;
      }

      // The permit is held from here, so this is where execution actually begins. Written
      // before the command runs rather than after, so a step that never returns is still
      // visible as running rather than as forever parked.
      await this.vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, join(instancePath, 'steps', stepName), {
        attrs: { status: 'running', startedAt: Date.now(), outputAt: undefined },
      });
      this.schedule(instancePath, () => this.advanceDAG(instancePath));
      this.runningInline.set(ticket.stepId, hangUp);
      let result;
      try {
        result = await this.runStep(command, join(instancePath, 'steps', stepName), ticket.attribution, hangUp.signal);
      } finally {
        this.runningInline.delete(ticket.stepId);
      }
      // The step was restarted or cancelled while it ran; what it says now stands.
      if (hangUp.signal.aborted) {
        logger.info('step overruled while running, its run dropped', { step: stepName, instance: instancePath });
      } else {
        const { code, stdout, stderr } = result;
        if (code !== 0 && code !== STEP_EXIT_TEMPORARY && await this.subjectVanished(instancePath)) {
          // The node went while the step ran, as when a photo is deleted during ingest: what the
          // step met was its absence, which no retry can change. The advance below cancels the
          // instance.
          logger.debug('step ended with its node gone, skipped', { step: stepName, instance: instancePath, code });
          await this.skipVanishedStep(ticket);
        } else if (code !== 0) {
          const detail = stepErrorDetail(code, stdout, stderr);
          // A step that could not run yet is not a failure; completeStep says it is waiting.
          if (code !== STEP_EXIT_TEMPORARY) {
            logger.error('step command failed', { step: stepName, command, code, detail: stepErrorLogDetail(code, stdout, stderr) });
          }
          await this.completeStep(ticket, code, detail);
        } else {
          await this.completeStep(ticket, code);
        }
      }
    } catch (err) {
      logger.error('step command threw', { step: stepName, command, error: String(err) });
      if (!hangUp.signal.aborted) await this.completeStep(ticket, 255, String(err));
    } finally {
      this.sem.release();
    }
    await this.advanceDAG(instancePath);
  }

  /**
   * Why a dispatch must not run, or undefined if it may: the step node at its path is no longer
   * the one it was issued for, or no longer 'queued' on the attempt it counted.
   */
  private async staleDispatch(ticket: DispatchTicket): Promise<string | undefined> {
    let node;
    try {
      node = await this.vfs.get<PipelineStepAttrs>(ADMIN_ACCESS, join(ticket.instancePath, 'steps', ticket.stepName));
    } catch {
      return 'step gone';
    }

    if (node.id !== ticket.stepId) return 'instance replaced';
    if (node.attrs.status !== 'queued') return `step ${node.attrs.status}`;
    if (node.attrs.attempts !== ticket.attempt) return 'dispatched again';
    return undefined;
  }

  /** Execute a step command in-process, returning its exit code and captured output. */
  private async runStep(
    command: string,
    stepPath: string,
    attribution: Attribution,
    signal: AbortSignal,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    // runAndCapture spawns a child exec context per call (output isolated); step
    // commands are #!ts builtins using absolute paths, so they don't mutate the
    // shared cwd/env — safe to run concurrently. `runStep` is shared with the pool worker.
    const output = markOutput(this.vfs, stepPath);
    try {
      return await runStep(this.tty, command, { signal, onOutput: output.onOutput, attribution });
    } finally {
      output.stop();
    }
  }

  /**
   * Update a step after execution: complete, retry (re-pend), or fail. Idempotent. A step that is
   * gone, or that a new instance for the same node has replaced, is left alone.
   */
  private async completeStep(ticket: DispatchTicket, code: number, errMsg?: string): Promise<void> {
    const { instancePath, stepName } = ticket;
    const stepPath = join(instancePath, 'steps', stepName);

    let attrs: PipelineStepAttrs;
    try {
      const node = await this.vfs.get<PipelineStepAttrs>(ADMIN_ACCESS, stepPath);
      if (node.id !== ticket.stepId) return;
      attrs = node.attrs;
    } catch {
      return; // step gone (instance cancelled/deleted)
    }

    // A concurrent path may have already finalized this step.
    if (attrs.status === 'completed' || attrs.status === 'failed' || attrs.status === 'skipped') {
      return;
    }

    if (code === 0) {
      await this.vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, stepPath, {
        attrs: { status: 'completed', completedAt: Date.now(), exitCode: 0 },
      });
      logger.info('step completed', { step: stepName, instance: instancePath });
      return;
    }

    const attempts = attrs.attempts ?? 0;
    const maxAttempts = attrs.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const error = errMsg ?? `exit ${code}`;

    // Not the step's failure: the run is not counted, and the step waits, however long that is.
    if (code === STEP_EXIT_TEMPORARY) {
      const waitMs = INLINE_TEMPORARY_WAIT_MS;
      await this.vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, stepPath, {
        attrs: { status: 'pending', startedAt: undefined, attempts: Math.max(0, attempts - 1), notBefore: Date.now() + waitMs, exitCode: code, error },
      });
      logger.warn('step could not run yet, waiting', {
        step: stepName,
        instance: instancePath,
        waitMs,
        detail: error,
      });
      return;
    }

    // The input is what cannot be processed: every run would meet the same bytes.
    if (code === STEP_EXIT_INPUT) {
      await this.vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, stepPath, {
        attrs: { status: 'failed', completedAt: Date.now(), exitCode: code, error, cause: 'input' },
      });
      logger.info('step failed on its input', { step: stepName, instance: instancePath });
      return;
    }

    if (attempts < maxAttempts) {
      // Re-pend for retry; the next advance re-dispatches and counts the attempt.
      await this.vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, stepPath, {
        attrs: { status: 'pending', startedAt: undefined, exitCode: code, error },
      });
      logger.info('step failed, retrying', { step: stepName, instance: instancePath, attempts, maxAttempts });
    } else {
      await this.vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, stepPath, {
        attrs: { status: 'failed', completedAt: Date.now(), exitCode: code, error },
      });
      logger.info('step failed', { step: stepName, instance: instancePath, attempts });
    }
  }

  /**
   * End a dispatched step that ran against a node gone meanwhile: skipped, as `TARGET_MISSING`.
   * Left alone, like `completeStep` leaves it, when it is gone, replaced or already ended.
   */
  private async skipVanishedStep(ticket: DispatchTicket): Promise<void> {
    const stepPath = join(ticket.instancePath, 'steps', ticket.stepName);

    try {
      const node = await this.vfs.get<PipelineStepAttrs>(ADMIN_ACCESS, stepPath);
      if (node.id !== ticket.stepId) return;
      if (node.attrs.status === 'completed' || node.attrs.status === 'failed' || node.attrs.status === 'skipped') return;
    } catch {
      return;
    }

    await this.vfs.update<PipelineStepAttrs>(ADMIN_ACCESS, stepPath, {
      attrs: { status: 'skipped', completedAt: Date.now(), error: TARGET_MISSING },
    });
  }

  private substitute(template: string, vars: Record<string, string>): string {
    let result = template;
    // Longest name first: otherwise `$EVENT_TYPE` would eat the prefix of
    // `$EVENT_TYPE_HINT` and leave a mangled tail behind.
    const names = Object.keys(vars).sort((a, b) => b.length - a.length);
    for (const key of names) {
      result = result.replaceAll(`$${key}`, vars[key]);
    }
    return result;
  }

  /**
   * A trigger's declarative `match` or `unless`, evaluated against the same env
   * a `filter` would have been given. True when every key matches; a key whose
   * value is a list matches if any glob does.
   *
   * A key is looked up as `EVENT_<NAME>` first and then `<NAME>`, so one
   * `mimetype: image/*` works for both the domain-fact form (which exposes
   * `EVENT_MIMETYPE`) and the VFS form (which exposes `MIMETYPE`).
   *
   * A key named `path` or ending in `Path` holds a path: its `*` stays within one
   * name and `**` crosses `/`. Any other key's `*` matches any characters.
   */
  private matchesTrigger(fields: Record<string, string | string[]>, env: Record<string, string>): boolean {
    for (const [key, globs] of Object.entries(fields)) {
      const name = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
      const value = env[`EVENT_${name}`] ?? env[name] ?? '';
      const patterns = Array.isArray(globs) ? globs : [globs];
      const pathname = key === 'path' || key.endsWith('Path');

      if (!patterns.some((glob) => globToRegex(glob, { pathname }).test(value))) {
        return false;
      }
    }

    return true;
  }

  /** `skipIfExists`, with `$NAME` from the trigger env substituted. */
  private async skipBecauseExists(path: string, env: Record<string, string>): Promise<boolean> {
    const resolved = this.substitute(path, env);

    try {
      return await this.vfs.exists(ADMIN_ACCESS, resolved);
    } catch {
      return false;
    }
  }

  /** `skipIfAttr`: true when the subject node already carries that attr. */
  private skipBecauseAttr(attr: string, attrs: Record<string, unknown>): boolean {
    const value = attrs[attr];
    return value !== undefined && value !== null && value !== '';
  }

  /**
   * A read-once reader for a trigger subject's attrs, shared by every definition
   * looking at the same event.
   *
   * The published VFS event is identity-only and a domain fact carries its own
   * data, so the attrs cost a node read — but the derived guard and `skipIfAttr`
   * both need them, and every definition in the loop asks about the same node.
   * Deferring the read to the first asker keeps an event nobody guards on free,
   * and memoizing it keeps a corpus-wide crawl from paying per definition. A
   * missing node reads as no attrs: it cannot be derived, and no attr is set.
   */
  private attrsReader(path: NodePath): () => Promise<Record<string, unknown>> {
    let attrs: Record<string, unknown> | undefined;

    return async () => {
      if (!attrs) {
        try {
          attrs = (await this.vfs.get(ADMIN_ACCESS, path)).attrs as Record<string, unknown>;
        } catch {
          attrs = {};
        }
      }
      return attrs;
    };
  }

  private async evalShell(script: string, vars: Record<string, string>): Promise<number> {
    // The trigger's variables go to a subshell of the engine shell, exported there and nowhere
    // else. Exported into the shell itself they outlived the evaluation (the next filter saw the
    // last event's), changed its state on every trigger, so the tty node was rewritten each time —
    // a row update per evaluation, ~500k an hour under a crawl (ein/core#510) — and a value
    // went through shell quoting, where a path holding `$(…)` would have been run. Never pass
    // `PATH` here: the trigger path is `NODE_PATH`.
    try {
      const result = await this.tty.runAndCapture(script, undefined, { env: vars });
      return result.code;
    } catch {
      return 1;
    }
  }
}
