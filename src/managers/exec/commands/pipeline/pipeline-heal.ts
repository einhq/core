/**
 * `pipeline heal` — run failed instances again once their cause may have passed.
 *
 * A failed instance used to stay failed until someone ran `pipeline rerun`, and the pruner
 * removed it within the hour on a busy pipeline, so nobody even saw it. Most failures are not
 * the input's: a bug since fixed, a model that could not load, a disk that was full. This
 * reruns each one after a wait that grows with every heal — `HEAL_AFTER_MS` — carrying the
 * count on the new instance (`healAttempts`), and after the last marks it `needsPerson` and
 * leaves it be. Three kinds are left alone from the start: a step that failed on its input
 * (`cause: 'input'`, bytes no decoder can open — every run would meet them again), an instance of
 * a pipeline no longer defined (nothing could run it), and an instance already marked, which the
 * query does not even return.
 *
 * `--now` skips the waits, for when the cause is known to have passed (a new EMS build). Such
 * a run is out of turn and does not count: the rerun keeps the heals it had, so a failure that
 * outlives the new build goes on up the ladder from where it was. Counted, three EMS deploys in an
 * afternoon marked instances for a person within the hour of their first failure (fry,
 * 2026-10-10). A dry run unless `--apply`, like `pipeline repair`.
 */

import { join } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import type { AttrCondition } from '../../../../vfs/query.ts';
import type { HealReport } from '../../../../lib/api/pipeline.ts';
import type { PipelineInstanceAttrs, PipelineStepAttrs } from '../../../pipeline/types.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { createInstanceFromDef, definitionsRoot, instancesRoot } from './lib.ts';

/** How long after its failure an instance is run again, by how many heals it has had. */
export const HEAL_AFTER_MS = [3_600_000, 6 * 3_600_000, 24 * 3_600_000];

/** Failed instances looked at per run, oldest failure first. */
const DEFAULT_LIMIT = 500;

type Verdict = 'rerun' | 'waiting' | 'input' | 'needs-person';

/** What to do with one failed instance — see the module comment. */
export const healVerdict = (attrs: PipelineInstanceAttrs, steps: PipelineStepAttrs[], now: number, immediately: boolean): Verdict => {
  if (steps.some((step) => step.status === 'failed' && step.cause === 'input')) return 'input';
  const heals = attrs.healAttempts ?? 0;
  if (heals >= HEAL_AFTER_MS.length) return 'needs-person';
  if (immediately) return 'rerun';
  return now - (attrs.completedAt ?? attrs.startedAt) >= HEAL_AFTER_MS[heals] ? 'rerun' : 'waiting';
};

export const pipelineHeal = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['apply', 'now'],
    string: ['limit'],
  });
  const limit = flags.limit === undefined ? DEFAULT_LIMIT : Number(flags.limit);
  if (!Number.isInteger(limit) || limit <= 0) {
    await cmd.writeError(`pipeline-heal: invalid --limit '${flags.limit}'\n`);
    return 1;
  }

  const instancesPath = instancesRoot(cmd);
  const prefix = `${instancesPath}/`;
  // Marked instances are left out here, or enough of them would fill every page ahead of the
  // failures still worth a run.
  const where: AttrCondition[] = [
    { ref: 'pipelineName', op: 'exists' },
    { ref: 'status', op: 'eq', value: 'failed' },
    { ref: 'needsPerson', op: 'missing' },
  ];
  const rows = await cmd.sys.vfs.query(cmd.access, { where, orderBy: { ref: 'completedAt', dir: 'asc' }, limit });

  const report: HealReport = { rerun: [], waiting: 0, input: 0, needsPerson: [], retired: 0 };
  const now = Date.now();
  let exitCode = 0;
  const defined = new Map<string, boolean>();
  const isDefined = async (name: string): Promise<boolean> => {
    if (!defined.has(name)) defined.set(name, await cmd.sys.vfs.exists(cmd.access, join(definitionsRoot(cmd), name), { follow: false }));
    return defined.get(name)!;
  };

  for (const row of rows) {
    if (!row.absPath.startsWith(prefix)) continue;
    const [pipelineName, id, ...rest] = row.absPath.slice(prefix.length).split('/');
    if (!pipelineName || !id || rest.length > 0) continue;
    if (!await isDefined(pipelineName)) {
      report.retired++;
      continue;
    }
    const attrs = row.node.attrs as PipelineInstanceAttrs;

    const steps: PipelineStepAttrs[] = [];
    for (const child of await cmd.sys.vfs.children(cmd.access, join(row.absPath, 'steps')).catch(() => [])) {
      steps.push(child.node.attrs as PipelineStepAttrs);
    }

    const verdict = healVerdict(attrs, steps, now, flags.now === true);
    const label = `${pipelineName}/${id}`;
    if (verdict === 'waiting') report.waiting++;
    else if (verdict === 'input') report.input++;
    else if (verdict === 'needs-person') {
      report.needsPerson.push(label);
      if (flags.apply) await cmd.sys.vfs.update(cmd.access, row.absPath, { attrs: { needsPerson: true } });
    } else {
      report.rerun.push(label);
      if (!flags.apply) continue;
      try {
        await createInstanceFromDef(cmd, pipelineName, attrs.triggerPath, attrs.vars, attrs.triggerEvent, attrs.priority, {
          healAttempts: flags.now ? attrs.healAttempts : (attrs.healAttempts ?? 0) + 1,
          triggerWrite: attrs.triggerWrite,
          lane: attrs.lane,
        });
      } catch (error) {
        await cmd.writeError(`pipeline-heal: ${label}: ${error instanceof Error ? error.message : String(error)}\n`);
        exitCode = 1;
      }
    }
  }

  if (cmd.json) {
    await cmd.writeJSON(report satisfies HealReport);
    return exitCode;
  }
  const verb = flags.apply ? '' : 'would ';
  await cmd.writeLn(
    `${verb}rerun ${report.rerun.length}, ${verb}mark ${report.needsPerson.length} for a person; ` +
      `${report.waiting} waiting, ${report.input} failed on their input` +
      (report.retired > 0 ? `, ${report.retired} of pipelines no longer defined` : ''),
  );
  return exitCode;
};

pipelineHeal.spec = {
  name: 'pipeline-heal',
  admin: true,
  effect: 'read' as const,
  description: 'Rerun failed instances after a growing wait, and mark those that keep failing for a person',
  args: [],
  flags: [
    { name: 'apply', writes: true, type: 'bool' as const, description: 'Rerun and mark (default is a dry run)' },
    { name: 'now', type: 'bool' as const, description: 'Skip the waits: the cause is known to have passed' },
    { name: 'limit', type: 'number' as const, description: `Failed instances to look at, oldest first (default ${DEFAULT_LIMIT})` },
  ],
};
