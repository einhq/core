import { createInstanceFromDef, instancesRoot, resolveInstance } from './lib.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const pipelineRerun = async (cmd: Command): CmdReturn => {
  const ids = cmd.args.filter((a) => !a.startsWith('-'));

  if (ids.length === 0) {
    await cmd.writeError('pipeline-rerun: missing instance id\n');
    return 1;
  }

  const instancesPath = instancesRoot(cmd);
  const newIds: string[] = [];
  const missingEventVars = new Set<string>();
  let exitCode = 0;

  for (const id of ids) {
    const found = await resolveInstance(cmd, instancesPath, id, 'pipeline-rerun');
    if (!found) {
      exitCode = 1;
      continue;
    }
    // createInstanceFromDef removes any prior instance for this (pipeline,
    // triggerPath) — including the one being rerun — and creates a fresh one
    // from the current definition. The engine advances it on the created event.
    // The run's variables come along, so rerunning a forced transcode stays
    // forced; if the definition has since dropped one, the rerun says so.
    //
    // The trigger event comes along for the same reason, and it is the one a
    // rerun cannot rebuild: a domain-triggered instance's steps read the fact's
    // fields as `$EVENT_*`, and the fact is long gone by the time anyone reruns.
    try {
      const created = await createInstanceFromDef(
        cmd,
        found.name,
        found.attrs.triggerPath,
        found.attrs.vars,
        found.attrs.triggerEvent,
        found.attrs.priority,
        { triggerWrite: found.attrs.triggerWrite },
      );
      newIds.push(created.id);
      for (const eventVar of created.missingEventVars) missingEventVars.add(eventVar);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await cmd.writeError(`pipeline-rerun: ${message}\n`);
      exitCode = 1;
    }
  }

  if (cmd.json) {
    await cmd.writeJSON({
      ids: newIds,
      ...(missingEventVars.size > 0 ? { missingEventVars: [...missingEventVars].sort() } : {}),
    });
    return exitCode;
  }

  for (const newId of newIds) await cmd.writeLn(newId);
  return exitCode;
};

pipelineRerun.spec = {
  name: 'pipeline-rerun',
  admin: true,
  effect: 'write' as const,
  description: 'Rerun pipeline(s) from the current definition, replacing the old instance',
  args: [
    { name: 'id', type: 'string' as const, description: 'Instance ID(s)' },
  ],
};
