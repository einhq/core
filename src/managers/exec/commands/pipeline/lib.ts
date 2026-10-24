import { PIPELINES_PATH, POOLS_PATH } from '../../../../lib/paths.ts';
import { join } from '@std/path';
import { toText } from '@std/streams/to-text';
import { type DomainEvent, eventEnv } from '../../../../lib/events/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../../../vfs/types/directory.ts';
import { eventVarsReferenced, parsePipeline } from '../../../pipeline/mod.ts';
import { instanceTree } from '../../../pipeline/step-attrs.ts';
import { isLiveInstance, type Lane, type PipelineInstanceAttrs, type PipelineStepAttrs } from '../../../pipeline/types.ts';
import type { AuditedWrite } from '../../../../lib/api/audit.ts';
import type { NodeEntry, NodeId } from '../../../../vfs/mod.ts';
import type { Command } from '../../command.ts';

type FoundInstance = {
  /** Full VFS path to the instance node. */
  path: string;
  /** Pipeline name (the parent dir under instances/). */
  name: string;
  attrs: PipelineInstanceAttrs;
};

/** Instances root for the current command's environment. */
export function instancesRoot(cmd: Command): string {
  const pipelinesPath = cmd.env.PIPELINES_PATH || PIPELINES_PATH;
  return join(pipelinesPath, 'instances');
}

/** Definitions root for the current command's environment. */
export function definitionsRoot(cmd: Command): string {
  const pipelinesPath = cmd.env.PIPELINES_PATH || PIPELINES_PATH;
  return join(pipelinesPath, 'definitions');
}

/** Thrown when a bare instance id exists under more than one pipeline. */
class AmbiguousInstanceError extends Error {
  constructor(public readonly id: string, public readonly pipelines: string[]) {
    super(
      `instance '${id}' exists in ${pipelines.length} pipelines (${pipelines.join(', ')}); ` +
        `qualify it as <pipeline>/${id}`,
    );
    this.name = 'AmbiguousInstanceError';
  }
}

/**
 * Locate an instance by `<pipeline>/<id>`, or by a bare id searched across every
 * pipeline dir.
 *
 * A bare id is not unique: instances are named after their trigger node, so one
 * file being processed by ten pipelines yields ten instances sharing an id. Returning the first match would silently act on whichever pipeline dir
 * happened to be listed first — so an ambiguous bare id is an error that tells
 * the caller how to qualify it.
 */
export async function findInstance(
  cmd: Command,
  instancesPath: string,
  instanceRef: string,
): Promise<FoundInstance | null> {
  const slash = instanceRef.lastIndexOf('/');

  if (slash > 0) {
    const name = instanceRef.slice(0, slash);
    const id = instanceRef.slice(slash + 1);
    const candidate = join(instancesPath, name, id);
    try {
      const node = await cmd.sys.vfs.get<PipelineInstanceAttrs>(cmd.access, candidate);
      return { path: candidate, name, attrs: node.attrs };
    } catch {
      return null;
    }
  }

  let dirs;
  try {
    dirs = await cmd.sys.vfs.children(cmd.access, instancesPath);
  } catch {
    return null;
  }

  const matches: FoundInstance[] = [];
  for (const dir of dirs) {
    const candidate = join(instancesPath, dir.name, instanceRef);
    try {
      const node = await cmd.sys.vfs.get<PipelineInstanceAttrs>(cmd.access, candidate);
      matches.push({ path: candidate, name: dir.name, attrs: node.attrs });
    } catch {
      // Not in this pipeline's directory.
    }
  }

  if (matches.length > 1) {
    throw new AmbiguousInstanceError(instanceRef, matches.map((m) => m.name));
  }

  return matches[0] ?? null;
}

/**
 * findInstance plus the two error messages every caller needs — not found, and
 * the ambiguity that a node-derived id makes possible.
 */
export async function resolveInstance(
  cmd: Command,
  instancesPath: string,
  instanceRef: string,
  cmdName: string,
): Promise<FoundInstance | null> {
  try {
    const found = await findInstance(cmd, instancesPath, instanceRef);

    if (!found) {
      await cmd.writeError(`${cmdName}: instance '${instanceRef}' not found\n`);
    }

    return found;
  } catch (error) {
    await cmd.writeError(`${cmdName}: ${error instanceof Error ? error.message : String(error)}\n`);
    return null;
  }
}

/**
 * Cancel the pool jobs backing an instance's steps.
 *
 * A queue-delegated job is self-cancelling — the worker re-validates the step at
 * execution time and drops a stale message. A pool job is not: it is a durable
 * row that stays claimable, and once the instance node is gone the worker's
 * re-validation cannot even find the step. Dropping the job explicitly is what
 * keeps a removed or reran instance from leaving work behind forever.
 */
async function cancelPoolJobs(cmd: Command, instancePath: string): Promise<void> {
  const stepsPath = join(instancePath, 'steps');

  let steps;
  try {
    steps = await cmd.sys.vfs.children<PipelineStepAttrs>(cmd.access, stepsPath);
  } catch {
    return; // No steps directory.
  }

  const poolsPath = cmd.env.POOLS_PATH || POOLS_PATH;

  for (const step of steps) {
    const pool = step.node.attrs.pool;
    if (!pool) continue;

    try {
      await cmd.sys.vfs.poolCancel(cmd.access, join(poolsPath, pool), { dedupKey: join(stepsPath, step.name) });
    } catch {
      // Pool or job already gone — nothing to drop.
    }
  }
}

/**
 * Cancel a running instance: set the instance status to cancelled, then mark
 * every non-terminal step skipped. Steps mid-execution finish on their own;
 * completeStep then no-ops because the step is no longer pending/running.
 *
 * The instance goes first because the engine's advance does not share a lock
 * with this command. An advance writes a step live and then re-reads the
 * instance (`stepOutlivedInstance`): a step it writes after the loop below has
 * read it is therefore one it sees cancelled and takes back itself
 * (ein/core#483). The steps go before their pool jobs for the same reason: an
 * advance re-reads the step after adding its job, and drops a job it added
 * after the drop below. The advance writes the instance itself only while its
 * status is the one it read, so it never writes over `cancelled` (ein/core#722).
 */
export async function cancelInstance(cmd: Command, instancePath: string): Promise<void> {
  await cmd.sys.vfs.update<PipelineInstanceAttrs>(cmd.access, instancePath, {
    attrs: { status: 'cancelled', completedAt: Date.now() },
  });
  const stepsPath = join(instancePath, 'steps');
  try {
    const steps = await cmd.sys.vfs.children<PipelineStepAttrs>(cmd.access, stepsPath);
    for (const step of steps) {
      const sa = step.node.attrs;
      // 'waiting' steps have a job queued; setting them 'skipped' is the cancel —
      // the owning worker re-validates at execution time and drops the stale job.
      if (
        sa.status === 'pending' || sa.status === 'queued' ||
        sa.status === 'waiting' || sa.status === 'running'
      ) {
        await cmd.sys.vfs.update<PipelineStepAttrs>(cmd.access, join(stepsPath, step.name), {
          attrs: { status: 'skipped', completedAt: Date.now() },
        });
      }
    }
  } catch {
    // No steps directory.
  }
  await cancelPoolJobs(cmd, instancePath);
}

/** Remove an instance node. If it is running, cancel it first. */
export async function removeInstance(cmd: Command, found: FoundInstance): Promise<void> {
  if (isLiveInstance(found.attrs.status)) {
    await cancelInstance(cmd, found.path);
  } else {
    // A terminal instance can still own a live job — e.g. a step left 'waiting'
    // under an instance that failed elsewhere. Unlinking would orphan it.
    await cancelPoolJobs(cmd, found.path);
  }
  const parent = join(instancesRoot(cmd), found.name);
  await cmd.sys.vfs.unlink(cmd.access, found.path, parent, { recursive: true });
}

/** One instance of a pipeline, as a query or listing of the pipeline's instances names it. */
export type InstanceRow = {
  /** The instance node's id. */
  id: NodeId;
  /** Its name under the pipeline's directory. */
  name: string;
  attrs: PipelineInstanceAttrs;
};

/**
 * Remove many instances of one pipeline, reaching each from its pipeline's directory by id
 * rather than resolving its path: instances being removed are paths nobody walked before, so no
 * path cache can serve them (ein/core#643). The steps of every terminal instance are
 * listed in one read, and their pool jobs dropped as `removeInstance` drops them. A live
 * instance is cancelled and removed by `removeInstance`.
 *
 * @returns one result per instance, in order; one that went in the meantime is rejected alone.
 */
export async function removeInstances(
  cmd: Command,
  pipelineName: string,
  instances: InstanceRow[],
): Promise<PromiseSettledResult<void>[]> {
  if (instances.length === 0) return [];

  const dirPath = join(instancesRoot(cmd), pipelineName);
  let dir: NodeEntry;
  try {
    dir = await cmd.sys.vfs.resolveEntry(cmd.access, dirPath);
  } catch (reason) {
    return instances.map(() => ({ status: 'rejected', reason }));
  }
  const entryIn = (parent: NodeEntry, name: string, id: NodeId): NodeEntry => ({
    id,
    vfs: parent.vfs,
    vfsAbsPath: join(parent.vfsAbsPath, name),
    absPath: join(parent.absPath || parent.vfsAbsPath, name),
  });

  const terminal = instances.filter((instance) => !isLiveInstance(instance.attrs.status));
  const links = await cmd.sys.vfs.getChildLinksByIds(cmd.access, terminal.map((instance) => instance.id));
  const stepDirs = terminal.flatMap((instance) => {
    const steps = links.get(instance.id)?.find((link) => link.name === 'steps');
    return steps ? [{ instance, entry: entryIn(entryIn(dir, instance.name, instance.id), 'steps', steps.id) }] : [];
  });
  const listings = await cmd.sys.vfs.childrenMany<PipelineStepAttrs>(cmd.access, stepDirs.map((stepDir) => stepDir.entry));

  // A terminal instance can still own a live job — e.g. a step left 'waiting' under an instance
  // that failed elsewhere. Unlinking would orphan it. The key is the step's path as the engine
  // named it, under the configured root rather than wherever that resolves.
  const poolsPath = cmd.env.POOLS_PATH || POOLS_PATH;
  for (const [index, listing] of listings.entries()) {
    if (listing.status === 'rejected') continue;
    const stepsPath = join(dirPath, stepDirs[index].instance.name, 'steps');
    for (const step of listing.value) {
      const pool = step.node.attrs.pool;
      if (!pool) continue;
      try {
        await cmd.sys.vfs.poolCancel(cmd.access, join(poolsPath, pool), { dedupKey: join(stepsPath, step.name) });
      } catch {
        // Pool or job already gone — nothing to drop.
      }
    }
  }

  const results: PromiseSettledResult<void>[] = [];
  for (const instance of instances) {
    try {
      if (isLiveInstance(instance.attrs.status)) {
        await removeInstance(cmd, { path: join(dirPath, instance.name), name: pipelineName, attrs: instance.attrs });
      } else {
        await cmd.sys.vfs.unlink(cmd.access, entryIn(dir, instance.name, instance.id), dir, { recursive: true });
      }
      results.push({ status: 'fulfilled', value: undefined });
    } catch (reason) {
      results.push({ status: 'rejected', reason });
    }
  }
  return results;
}

/**
 * Delete the instance for a (pipeline, trigger node), skipping `exceptId`.
 * Cancels it first if running. Returns the count removed. This is the
 * one-per-node enforcement shared by rerun and start.
 *
 * An instance is named after its trigger node's id, so this is a single lookup
 * rather than a scan of a directory that can hold hundreds of thousands of
 * children.
 */
async function removeInstancesForTriggerPath(
  cmd: Command,
  pipelineInstancesPath: string,
  instanceId: string,
  exceptId?: string,
): Promise<number> {
  if (instanceId === exceptId) return 0;

  const path = join(pipelineInstancesPath, instanceId);

  let attrs: PipelineInstanceAttrs;
  try {
    attrs = (await cmd.sys.vfs.get<PipelineInstanceAttrs>(cmd.access, path)).attrs;
  } catch {
    return 0;
  }

  if (isLiveInstance(attrs.status)) {
    await cancelInstance(cmd, path);
  } else {
    await cancelPoolJobs(cmd, path);
  }
  await cmd.sys.vfs.unlink(cmd.access, path, pipelineInstancesPath, { recursive: true });

  return 1;
}

export type CreatedInstance = {
  /** The new instance's id — the trigger node's own id. */
  id: string;
  /**
   * `EVENT_*` names the definition reads that this run has no value for.
   *
   * Returned as well as warned about on stderr: the api-shell drops stderr from
   * a command that exited 0, so a JSON caller would otherwise never see it.
   */
  missingEventVars: string[];
};

/**
 * Create a fresh instance for `name` targeting `triggerPath` from the current
 * definition, first removing any prior instance for that (pipeline, triggerPath)
 * so at most one exists per node. Returns the new instance id.
 *
 * `vars` overrides the definition's declared defaults for this run only. A name
 * the definition does not declare is an error rather than a no-op: a substituted
 * variable that never arrives leaves the step running as if nothing was asked.
 *
 * `triggerEvent` is the fact a domain-triggered run was started with, carried
 * over by `pipeline rerun`. Without it the instance's steps get only
 * `$NODE_PATH`, so any `$EVENT_*` they read substitutes to nothing — which is
 * why a name that cannot be supplied is reported up front. `opts.triggerWrite`, carried over the
 * same way, keeps the new run's writes pointing at the write that set the first one off.
 * `opts.lane` is the run's lane (`PipelineInstanceAttrs.lane`); without it the run is in the normal lane.
 * @throws if the pipeline is not defined, its YAML is invalid, or a var is undeclared.
 */
export async function createInstanceFromDef(
  cmd: Command,
  name: string,
  triggerPath: string,
  vars?: Record<string, string>,
  triggerEvent?: DomainEvent,
  priority?: number,
  opts: { healAttempts?: number; triggerWrite?: AuditedWrite; lane?: Lane } = {},
): Promise<CreatedInstance> {
  const defPath = join(definitionsRoot(cmd), name);

  let yaml: string;
  try {
    const handle = await cmd.sys.vfs.open(cmd.access, defPath, { mode: 'r' });
    try {
      yaml = await toText(handle.readable);
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error(`unknown pipeline '${name}'`);
  }

  const def = parsePipeline(yaml);

  const declared = def.vars ?? {};
  for (const key of Object.keys(vars ?? {})) {
    if (!(key in declared)) {
      const known = Object.keys(declared);
      throw new Error(`pipeline '${name}' declares no variable '${key}'${known.length ? ` (has ${known.join(', ')})` : ''}`);
    }
  }
  const resolvedVars = { ...declared, ...vars };

  // The engine substitutes `$EVENT_*` from the instance's own event, so a name
  // this run has no value for would reach the shell as an empty word. Say so
  // here, where the caller is still watching, instead of leaving a step to run
  // one argument short.
  const supplied = new Set(Object.keys(triggerEvent ? eventEnv(triggerEvent) : {}));
  const missingEventVars = eventVarsReferenced(def).filter((eventVar) => !supplied.has(eventVar));
  if (missingEventVars.length > 0) {
    await cmd.writeError(
      `warning: pipeline '${name}' reads ${missingEventVars.join(', ')}, which this run has no value for; ` +
        `its steps run with them empty\n`,
    );
  }

  const instancesPath = instancesRoot(cmd);
  const pipelineInstancesPath = join(instancesPath, name);

  // The instance is named after its trigger node, which makes "at most one instance per node"
  // structural and every later lookup a direct get. Throws if the node does not exist.
  const trigger = await cmd.sys.vfs.get(cmd.access, triggerPath);
  const instanceId = trigger.id;

  await cmd.sys.vfs.ensure(cmd.access, NODE_TYPE_DIRECTORY, instancesPath, name);
  // One-per-node: drop any prior instance for this file before creating.
  await removeInstancesForTriggerPath(cmd, pipelineInstancesPath, instanceId);

  // One transaction for the instance node, `steps/` and every step — see
  // `instanceTree`. Until it commits nothing can read a step-less instance.
  await cmd.sys.vfs.createTree(cmd.access, pipelineInstancesPath, [
    instanceTree(instanceId, {
      pipelineName: name,
      triggerPath,
      triggerNodeId: instanceId,
      triggerCreator: trigger.props.birthtime.uid,
      // Nothing executes yet: the advance flips it to 'running' once a step is on a core.
      status: 'queued',
      startedAt: Date.now(),
      triggerEvent,
      triggerWrite: opts.triggerWrite,
      vars: Object.keys(resolvedVars).length > 0 ? resolvedVars : undefined,
      priority: priority ?? def.options?.priority,
      lane: opts.lane,
      healAttempts: opts.healAttempts,
    }, def),
  ]);

  return { id: instanceId, missingEventVars };
}
