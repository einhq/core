/**
 * `pipeline undefine` — remove a pipeline definition, and cancel its instances still running.
 *
 * An instance runs from the steps it was created with, so one left behind would go on: its pooled
 * steps re-queued under kinds no worker may offer any more, waiting for good. A pipeline that is
 * gone has no work left to do, so its live instances are cancelled with it. Finished instances
 * are left for the pruner.
 */

import { dirname, join } from '@std/path';
import { PIPELINES_PATH } from '../../../../lib/paths.ts';
import { cancelInstance, instancesRoot } from './lib.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

/** Live instances cancelled per query: a cancelled one no longer matches, so the next page is the rest. */
const PAGE = 500;

/** Cancel every live instance of `name`, and say how many there were. */
const cancelLiveInstances = async (cmd: Command, name: string): Promise<number> => {
  const prefix = `${join(instancesRoot(cmd), name)}/`;
  let cancelled = 0;
  for (;;) {
    const rows = await cmd.sys.vfs.query(cmd.access, {
      where: [{ ref: 'pipelineName', op: 'eq', value: name }, { ref: 'status', op: 'in', value: ['running', 'queued'] }],
      limit: PAGE,
    });
    const live = rows.filter((row) => row.absPath.startsWith(prefix) && !row.absPath.slice(prefix.length).includes('/'));
    for (const row of live) await cancelInstance(cmd, row.absPath);
    cancelled += live.length;
    if (rows.length < PAGE || live.length === 0) return cancelled;
  }
};

export const pipelineUndefine = async (cmd: Command): CmdReturn => {
  const name = cmd.args[0];

  if (!name) {
    await cmd.writeError('pipeline-undefine: missing pipeline name\n');
    return 1;
  }

  const pipelinesPath = cmd.env.PIPELINES_PATH || PIPELINES_PATH;
  const linkPath = join(pipelinesPath, 'definitions', name);

  if (!await cmd.sys.vfs.exists(cmd.access, linkPath, { follow: false })) {
    await cmd.writeError(`pipeline-undefine: '${name}' is not defined\n`);
    return 1;
  }

  try {
    await cmd.sys.vfs.unlink(cmd.access, linkPath, dirname(linkPath), { readlink: true });
    const cancelled = await cancelLiveInstances(cmd, name);
    if (cmd.json) {
      await cmd.writeJSON({ ok: true, cancelled });
    } else {
      await cmd.write(`Undefined pipeline '${name}'${cancelled > 0 ? `; cancelled ${cancelled} running instance(s)` : ''}\n`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`pipeline-undefine: ${message}\n`);
    return 1;
  }
};

pipelineUndefine.spec = {
  name: 'pipeline-undefine',
  admin: true,
  effect: 'write' as const,
  description: 'Remove a pipeline definition, and cancel its running instances',
  args: [
    { name: 'name', type: 'string' as const, description: 'Pipeline name to undefine' },
  ],
};
