/**
 * pipeline-prune — remove terminal instances.
 *
 * Two modes. Without `--keep` or `--older-than` it sweeps a whole directory,
 * which is what you want interactively ("clear this out"). With either it is
 * retention, the form a scheduler can run unattended: `--keep n` lets the n most
 * recently completed instances of each pipeline survive, `--older-than d` lets
 * those completed within d survive, and given both an instance goes when either
 * bound says so.
 *
 * Retention goes through `vfs.query` on `completedAt` rather than `children()`,
 * so it never materialises the directory it is there to bound.
 * Running instances have no `completedAt` and `vfs.query` excludes rows lacking
 * the ordering attr — so retention structurally cannot touch live work. Nor does
 * it touch a failed instance unless asked (`--status failed`): those are
 * `pipeline heal`'s, run again or marked for a person, and on a busy pipeline the
 * cap used to remove a failure within the hour, before anything could look at it.
 *
 * `--budget` bounds retention by wall time as well as by count: a removal
 * costs ~0.3 s, and a first pass over a backlog bounded only by `--max` once
 * took over 80 minutes, all of it competing with a crawl for the database.
 *
 * Given neither a name nor a status, it also retires pipelines that are no longer
 * defined: an instance directory whose definition is gone loses every instance and
 * then the directory itself, with its banked total. Retention would otherwise keep
 * a renamed pipeline's newest runs, and its failures, for good — nothing can run
 * them again.
 */

import { parseArgs } from '../../../../lib/args/mod.ts';
import { join } from '@std/path';
import { definitionsRoot, type InstanceRow, instancesRoot, removeInstances } from './lib.ts';
import { parseDuration } from '../pool/lib.ts';
import type { PipelineInstanceAttrs } from '../../../pipeline/types.ts';
import type { AttrCondition, NodeQueryCursor } from '../../../../vfs/query.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

const TERMINAL = ['completed', 'failed', 'cancelled'];

/** What retention removes when no status is named: the terminal states nothing else is waiting on. */
const RETAINED_TERMINAL = ['completed', 'cancelled'];

/** Rows per query while walking the tail. */
const PAGE = 200;

/**
 * What a `/var/pipelines/instances/<name>` directory remembers about its own
 * pruning.
 *
 * Deleting an instance also deletes the only evidence it ever completed, so a
 * count of surviving rows stops being a counter the first time retention bites:
 * it pins at `--keep` and reports that number forever. Banking the removals here
 * is what keeps "how many has this pipeline ever completed" answerable, which
 * the metrics sampler differences into a throughput.
 *
 * Deliberately only maintained here. `pipeline remove` and `pipeline rerun` also
 * delete instances and do *not* bank them — those are deliberate operator
 * actions on specific instances rather than retention, and quietly folding them
 * in would make the total drift up every time somebody re-ran something.
 */
export type PrunedCompletedAttrs = { prunedCompleted?: number };

/**
 * When a prune first found an instance directory's pipeline undefined, epoch ms. Cleared when
 * the definition is back.
 */
type UndefinedSinceAttrs = { undefinedSince?: number };

/**
 * How long a definition has to stay gone before its pipeline is retired. Redefining a pipeline
 * unlinks its definition and links it again, and `mod setup` redefines every pipeline it ships;
 * a definition seen missing once may be one in that gap.
 */
export const RETIRE_GRACE_MS = 10 * 60 * 1000;

export const pipelinePrune = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['s', 'keep', 'max', 'budget', 'older-than'],
    boolean: ['all'],
    alias: { s: 'status' },
  });
  const name = flags._[0] as string | undefined;

  const instancesPath = instancesRoot(cmd);

  /** null means "given but not a count", which the caller reports. */
  const numeric = (raw: string | undefined): number | undefined | null => {
    if (raw === undefined) return undefined;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : null;
  };

  const keep = numeric(flags.keep);
  if (keep === null) {
    await cmd.writeError(`pipeline-prune: invalid --keep '${flags.keep}' (expected a non-negative integer)\n`);
    return 1;
  }
  const max = numeric(flags.max);
  if (max === null) {
    await cmd.writeError(`pipeline-prune: invalid --max '${flags.max}' (expected a non-negative integer)\n`);
    return 1;
  }

  let budgetMs: number | undefined;
  let olderThanMs: number | undefined;
  try {
    budgetMs = parseDuration(flags.budget, '--budget');
    olderThanMs = parseDuration(flags['older-than'], '--older-than');
  } catch (error) {
    await cmd.writeError(`pipeline-prune: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const deadline = budgetMs === undefined ? undefined : Date.now() + budgetMs;
  const before = olderThanMs === undefined ? undefined : Date.now() - olderThanMs;

  let pipelineNames: string[];
  if (name) {
    pipelineNames = [name];
  } else {
    try {
      const dirs = await cmd.sys.vfs.children(cmd.access, instancesPath);
      pipelineNames = dirs.map((d) => d.name);
    } catch {
      pipelineNames = [];
    }
  }

  let removed = 0;
  let retired: string[] = [];
  if (!name && !flags.status) {
    const retirement = await retireUndefined(cmd, instancesPath, pipelineNames, deadline);
    removed += retirement.removed;
    retired = retirement.retired;
    pipelineNames = pipelineNames.filter((pName) => !retirement.undefined.has(pName));
  }

  removed += keep === undefined && before === undefined
    ? await pruneAll(cmd, instancesPath, pipelineNames, flags)
    : await pruneRetained(cmd, instancesPath, pipelineNames, { keep, before, max, deadline, status: flags.status });

  if (cmd.json) {
    await cmd.writeJSON({ removed, retired });
    return 0;
  }

  for (const pName of retired) await cmd.write(`Retired pipeline '${pName}': no definition\n`);
  await cmd.write(`Pruned ${removed} instance(s)\n`);
  return 0;
};

/**
 * Remove the instances of every pipeline whose definition has been gone for `RETIRE_GRACE_MS`,
 * then its directory. A directory found undefined for the first time is only marked.
 *
 * The definition is looked for again before each page, so one that comes back part way through
 * stops the removal. Pages, not a listing: a pipeline renamed with a backlog behind it can hold
 * more instances than a listing should materialise. Returns what it removed, the pipelines it
 * finished retiring, and every pipeline it found undefined, which the retention pass leaves to
 * it.
 */
async function retireUndefined(
  cmd: Command,
  instancesPath: string,
  pipelineNames: string[],
  deadline: number | undefined,
): Promise<{ removed: number; retired: string[]; undefined: Set<string> }> {
  const result = { removed: 0, retired: [] as string[], undefined: new Set<string>() };
  const definitionsPath = definitionsRoot(cmd);

  // Read without following: a definition is a link, and one whose YAML cannot be read right now
  // is still a definition.
  let defined: Set<string>;
  try {
    defined = new Set((await cmd.sys.vfs.children(cmd.access, definitionsPath, { readlink: true })).map((entry) => entry.name));
  } catch {
    // No definitions directory says nothing about which pipelines are retired.
    return result;
  }
  const isDefined = (pName: string) => cmd.sys.vfs.exists(cmd.access, join(definitionsPath, pName), { follow: false });

  for (const pName of pipelineNames) {
    const dirPath = join(instancesPath, pName);
    let since: number | undefined;
    try {
      since = (await cmd.sys.vfs.get<UndefinedSinceAttrs>(cmd.access, dirPath)).attrs.undefinedSince;
    } catch {
      continue;
    }

    if (defined.has(pName)) {
      if (since !== undefined) await cmd.sys.vfs.update<UndefinedSinceAttrs>(cmd.access, dirPath, { attrs: { undefinedSince: null } });
      continue;
    }

    result.undefined.add(pName);
    if (since === undefined) {
      await cmd.sys.vfs.update<UndefinedSinceAttrs>(cmd.access, dirPath, { attrs: { undefinedSince: Date.now() } });
      continue;
    }
    if (Date.now() - since < RETIRE_GRACE_MS) continue;

    const prefix = dirPath + '/';
    while (true) {
      if (deadline !== undefined && Date.now() >= deadline) return result;
      if (await isDefined(pName)) {
        await cmd.sys.vfs.update<UndefinedSinceAttrs>(cmd.access, dirPath, { attrs: { undefinedSince: null } });
        break;
      }

      const page = await cmd.sys.vfs.query(cmd.access, { where: [{ ref: 'pipelineName', op: 'eq', value: pName }], limit: PAGE });
      const targets = page.flatMap((row): InstanceRow[] => {
        const name = row.absPath.slice(prefix.length);
        if (!row.absPath.startsWith(prefix) || name.includes('/')) return [];
        return [{ id: row.id, name, attrs: row.node.attrs as PipelineInstanceAttrs }];
      });

      if (page.length === 0) {
        await cmd.sys.vfs.unlink(cmd.access, dirPath, instancesPath, { recursive: true });
        result.retired.push(pName);
        break;
      }

      const removed = (await removeInstances(cmd, pName, targets)).filter((outcome) => outcome.status === 'fulfilled').length;
      result.removed += removed;
      // A page that removes nothing would come back the same: the next run tries again.
      if (removed === 0) break;
    }
  }

  return result;
}

/**
 * How many of `targets` were completed and removed, `outcomes` being `removeInstances`'s answer for them.
 */
const completedRemoved = (targets: InstanceRow[], outcomes: PromiseSettledResult<void>[]): number =>
  targets.filter((target, index) => target.attrs.status === 'completed' && outcomes[index]?.status === 'fulfilled').length;

/**
 * Add `count` completed removals to a pipeline's banked total.
 *
 * Banked *after* the removal, so a sample never counts a page twice (once live, once banked);
 * one taken in between sees the total dip, which the `pipelines` series' readers measure
 * against the highest count so far and so do not take for growth when it comes back.
 *
 * Read-modify-write, and knowingly not atomic: the pruner is a single scheduled
 * service, and losing a handful of counts to a concurrent run would cost a small
 * undercount on a figure whose whole purpose is to be roughly right and always
 * increasing. Failure is swallowed for the same reason — the prune itself
 * succeeded, and refusing to delete because bookkeeping failed would be worse.
 */
async function bankPruned(cmd: Command, instancesPath: string, pipelineName: string, count: number): Promise<void> {
  if (count <= 0) return;

  const path = join(instancesPath, pipelineName);
  try {
    const node = await cmd.sys.vfs.get<PrunedCompletedAttrs>(cmd.access, path);
    const banked = node.attrs?.prunedCompleted;
    await cmd.sys.vfs.update<PrunedCompletedAttrs>(cmd.access, path, {
      attrs: { prunedCompleted: (typeof banked === 'number' ? banked : 0) + count },
    });
  } catch {
    // The directory went away, or is not writable by this caller.
  }
}

/** Sweep every matching instance in the listed directories. */
async function pruneAll(
  cmd: Command,
  instancesPath: string,
  pipelineNames: string[],
  flags: { status?: string; all?: boolean },
): Promise<number> {
  const terminal = new Set(TERMINAL);
  const shouldRemove = (status: string): boolean => {
    if (flags.status) return status === flags.status;
    if (flags.all) return true;
    return terminal.has(status);
  };

  let removed = 0;
  for (const pName of pipelineNames) {
    const pPath = join(instancesPath, pName);
    let instances;
    try {
      instances = await cmd.sys.vfs.children<PipelineInstanceAttrs>(cmd.access, pPath);
    } catch {
      continue;
    }
    const doomed = instances.filter((inst) => shouldRemove(inst.node.attrs.status));

    // An instance can go between the listing above and the removal below: the pipeline-pruner
    // service prunes on its own schedule, and an engine advance can finish and remove one too.
    // That is a race this sweep wins by ignoring, not an error that ends the run.
    for (let start = 0; start < doomed.length; start += PAGE) {
      const batch = doomed.slice(start, start + PAGE).map((inst) => ({ id: inst.node.id, name: inst.name, attrs: inst.node.attrs }));
      const outcomes = await removeInstances(cmd, pName, batch);
      await bankPruned(cmd, instancesPath, pName, completedRemoved(batch, outcomes));
      removed += outcomes.filter((outcome) => outcome.status === 'fulfilled').length;
    }
  }
  return removed;
}

/**
 * Keep the `keep` most recently completed instances of each pipeline, and those
 * completed at or after `before` (epoch ms); remove the rest. With both, an
 * instance survives only if both keep it. `max` bounds the work per pipeline, so
 * a scheduled run converges over several cycles instead of deleting a whole
 * backlog in one burst — and per pipeline rather than in total, or the largest
 * one would absorb the whole budget every cycle and the rest would never be swept.
 *
 * The pipelines take turns a page at a time, so a `deadline` reached part way
 * through leaves every pipeline with some of its share done rather than the
 * first few with all of it. The deadline is checked between pages, never inside
 * one: a page is banked once it is removed, and stopping half way would leave
 * removed instances unbanked. A page can therefore run past it, by at most
 * one page.
 */
async function pruneRetained(
  cmd: Command,
  instancesPath: string,
  pipelineNames: string[],
  options: { keep?: number; before?: number; max?: number; deadline?: number; status?: string },
): Promise<number> {
  const { keep, before, max, deadline, status } = options;
  type Query = (after: NodeQueryCursor | undefined, limit: number) => ReturnType<typeof cmd.sys.vfs.query>;
  type Sweep = { name: string; query: Query; cursor: NodeQueryCursor | undefined; removed: number };

  const queryOf = (where: AttrCondition[]): Query => (after, limit) => cmd.sys.vfs.query(cmd.access, { where, orderBy: { ref: 'completedAt', dir: 'desc' }, after, limit });

  // Conditions compare text, and `completedAt` is epoch ms: thirteen digits, so text order is
  // numeric order, as the ordering above already relies on.
  const older: AttrCondition[] = before === undefined ? [] : [{ ref: 'completedAt', op: 'lt', value: before }];
  const recent: AttrCondition[] = before === undefined ? [] : [{ ref: 'completedAt', op: 'gte', value: before }];

  // Find where each pipeline's survivors end. Newest first, so whatever comes after
  // the `keep`th recent instance is over the cap or too old; with fewer recent ones
  // than that, only the old ones go.
  let sweeps: Sweep[] = [];
  for (const pName of pipelineNames) {
    const where: AttrCondition[] = [{ ref: 'pipelineName', op: 'eq', value: pName }];
    if (status) where.push({ ref: 'status', op: 'eq', value: status });
    else where.push({ ref: 'status', op: 'in', value: RETAINED_TERMINAL });

    if (keep === undefined) {
      sweeps.push({ name: pName, query: queryOf([...where, ...older]), cursor: undefined, removed: 0 });
      continue;
    }

    const survivors = queryOf([...where, ...recent]);
    let cursor: NodeQueryCursor | undefined;
    let seen = 0;
    while (seen < keep) {
      const page = await survivors(cursor, Math.min(PAGE, keep - seen));
      if (page.length === 0) break;
      const last = page[page.length - 1];
      cursor = { value: last.sortValue, id: last.id };
      seen += page.length;
    }

    if (seen === keep) sweeps.push({ name: pName, query: queryOf(where), cursor, removed: 0 });
    else if (before !== undefined) sweeps.push({ name: pName, query: queryOf([...where, ...older]), cursor: undefined, removed: 0 });
  }

  // Everything after a pipeline's cursor goes. One page per pipeline
  // per round, until each is done or out of `max`, or the deadline passes.
  let removed = 0;
  while (sweeps.length > 0) {
    const next: Sweep[] = [];
    for (const sweep of sweeps) {
      if (deadline !== undefined && Date.now() >= deadline) return removed;

      const page = await sweep.query(sweep.cursor, max === undefined ? PAGE : Math.min(PAGE, max - sweep.removed));
      if (page.length === 0) continue;
      sweep.cursor = { value: page[page.length - 1].sortValue, id: page[page.length - 1].id };

      const dirPrefix = join(instancesPath, sweep.name) + '/';
      const targets = page.flatMap((row): InstanceRow[] => {
        const name = row.absPath.slice(dirPrefix.length);
        if (!row.absPath.startsWith(dirPrefix) || name.includes('/')) return [];
        return [{ id: row.id, name, attrs: row.node.attrs as PipelineInstanceAttrs }];
      });

      // Same race as the sweep above, and it matters more here: this path is what the
      // pipeline-pruner service runs on a schedule, so an instance disappearing under it is
      // the ordinary case rather than the exception.
      const outcomes = await removeInstances(cmd, sweep.name, targets);
      await bankPruned(cmd, instancesPath, sweep.name, completedRemoved(targets, outcomes));
      const gone = outcomes.filter((outcome) => outcome.status === 'fulfilled').length;
      sweep.removed += gone;
      removed += gone;

      if (max === undefined || sweep.removed < max) next.push(sweep);
    }
    sweeps = next;
  }

  return removed;
}

pipelinePrune.spec = {
  name: 'pipeline-prune',
  admin: true,
  effect: 'write' as const,
  description: 'Remove terminal pipeline instances (completed/failed/cancelled)',
  args: [
    { name: 'name', type: 'string' as const, description: 'Pipeline name (optional; all if omitted)' },
  ],
  flags: [
    { name: 's', type: 'string' as const, description: 'Only remove instances with this status' },
    { name: 'all', type: 'bool' as const, description: 'Remove all instances, including running (cancels first)' },
    { name: 'keep', type: 'string' as const, description: 'Retention cap: keep this many newest per pipeline, remove the rest' },
    { name: 'max', type: 'string' as const, description: 'Stop after removing this many per pipeline (with --keep or --older-than)' },
    { name: 'older-than', type: 'string' as const, description: 'Retention by age: remove those completed longer ago than this, e.g. 30d' },
    { name: 'budget', type: 'string' as const, description: 'Stop starting new pages after this long, e.g. 15m (with --keep or --older-than)' },
  ],
};
