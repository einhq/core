/**
 * pipeline-repair — rescue instances that are marked terminal while still
 * holding unfinished steps. Every advance short-circuits on a terminal
 * instance's status, so such steps are never run.
 *
 * Repair = put the instance back to 'running' and re-pend any step left
 * mid-flight, then let the engine's watcher pick it up. Sound for the same
 * reason recover() is: step commands are idempotent and guarded by their
 * condition.
 *
 * Dry-run by default — the repair re-enters real work (on a media corpus, GPU
 * work), so acting is opt-in.
 */

import { dirname } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { instancesRoot } from './lib.ts';
import type { PipelineInstanceAttrs, PipelineStepAttrs } from '../../../pipeline/types.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const UNFINISHED = ['pending', 'queued', 'waiting', 'running'];

/** Batch size for the keyset walk over unfinished steps. */
const PAGE = 500;

export const pipelineRepair = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { boolean: ['apply'] });
  const instancesPath = instancesRoot(cmd);
  const prefix = instancesPath + '/';

  // Instance path -> the step names under it that are not finished.
  const byInstance = new Map<string, string[]>();
  let scanned = 0;

  let after: { value: string | null; id: string } | undefined;
  for (;;) {
    const rows = await cmd.sys.vfs.query(cmd.access, {
      where: [
        { ref: 'stepName', op: 'exists' },
        { ref: 'status', op: 'in', value: UNFINISHED },
      ],
      after,
      limit: PAGE,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      scanned++;
      // <instances>/<pipeline>/<id>/steps/<step>
      if (!row.absPath.startsWith(prefix)) continue;
      const stepsDir = dirname(row.absPath);
      if (!stepsDir.endsWith('/steps')) continue;
      const instancePath = dirname(stepsDir);
      const names = byInstance.get(instancePath);
      if (names) names.push(row.absPath);
      else byInstance.set(instancePath, [row.absPath]);
    }

    if (rows.length < PAGE) break;
    after = { value: null, id: rows[rows.length - 1].id };
  }

  const broken: { instance: string; status: string; steps: number }[] = [];

  for (const [instancePath, stepPaths] of byInstance) {
    let attrs: PipelineInstanceAttrs;
    try {
      attrs = (await cmd.sys.vfs.get<PipelineInstanceAttrs>(cmd.access, instancePath)).attrs;
    } catch {
      continue; // Removed meanwhile.
    }
    if (!TERMINAL.has(attrs.status)) continue;

    // Re-read every candidate step before believing the query. An instance
    // finishing normally *while the query ran* leaves rows that were unfinished
    // when they were read and are finished by now — reporting those as stranded
    // is noise, and re-pending them would undo completed work and re-run it.
    const unfinished: string[] = [];
    for (const stepPath of stepPaths) {
      try {
        const step = await cmd.sys.vfs.get<PipelineStepAttrs>(cmd.access, stepPath);
        if (UNFINISHED.includes(step.attrs.status)) unfinished.push(stepPath);
      } catch { /* Removed meanwhile. */ }
    }
    if (unfinished.length === 0) continue;

    broken.push({ instance: instancePath, status: attrs.status, steps: unfinished.length });

    if (!flags.apply) continue;

    // Steps first: a 'running'/'waiting' step in a terminal instance is stale —
    // nothing owns it — so re-pend it the way recover() does for an interrupted
    // one. Keep `attempts` so a crash-looping step still exhausts its retries.
    for (const stepPath of unfinished) {
      try {
        await cmd.sys.vfs.update<PipelineStepAttrs>(cmd.access, stepPath, {
          attrs: { status: 'pending', startedAt: undefined },
        });
      } catch { /* Removed meanwhile. */ }
    }

    // Instance last: this is the write the engine's watcher reacts to, so the
    // steps are already in a dispatchable state when the advance lands.
    await cmd.sys.vfs.update<PipelineInstanceAttrs>(cmd.access, instancePath, {
      attrs: { status: 'queued', completedAt: undefined, executingSince: undefined },
    });
  }

  if (cmd.json) {
    await cmd.writeJSON({ scanned, broken: broken.length, repaired: flags.apply ? broken.length : 0, instances: broken });
    return 0;
  }

  for (const item of broken) {
    await cmd.writeLn(`${item.status}\t${item.steps}\t${item.instance}`);
  }
  await cmd.write(
    flags.apply
      ? `Repaired ${broken.length} instance(s) (${scanned} unfinished steps scanned)\n`
      : `Found ${broken.length} instance(s) terminal with unfinished steps (${scanned} scanned); re-run with --apply\n`,
  );
  return 0;
};

pipelineRepair.spec = {
  name: 'pipeline-repair',
  admin: true,
  effect: 'read' as const,
  description: 'Return instances marked terminal while still holding unfinished steps to running',
  args: [],
  flags: [
    { name: 'apply', writes: true, type: 'bool' as const, description: 'Perform the repair (default is a dry run)' },
  ],
};
