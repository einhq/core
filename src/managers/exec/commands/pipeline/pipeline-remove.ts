import { parseArgs } from '../../../../lib/args/mod.ts';
import { findInstance, instancesRoot, removeInstance } from './lib.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const pipelineRemove = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['f', 'force'],
    alias: { f: 'force' },
  });
  const ids = flags._;

  if (ids.length === 0) {
    await cmd.writeError('pipeline-remove: missing instance id\n');
    return 1;
  }

  const instancesPath = instancesRoot(cmd);
  let removed = 0;
  let exitCode = 0;

  for (const id of ids) {
    // Not resolveInstance: -f deliberately stays quiet about a missing id, but
    // an ambiguous one is a different problem and must always be reported.
    let found;
    try {
      found = await findInstance(cmd, instancesPath, id);
    } catch (error) {
      await cmd.writeError(`pipeline-remove: ${error instanceof Error ? error.message : String(error)}\n`);
      exitCode = 1;
      continue;
    }

    if (!found) {
      if (!flags.force) {
        await cmd.writeError(`pipeline-remove: instance '${id}' not found\n`);
        exitCode = 1;
      }
      continue;
    }
    // A running instance is cancelled first, then deleted.
    await removeInstance(cmd, found);
    removed++;
  }

  if (cmd.json) {
    await cmd.writeJSON({ removed });
    return exitCode;
  }

  await cmd.write(`Removed ${removed} instance(s)\n`);
  return exitCode;
};

pipelineRemove.spec = {
  name: 'pipeline-remove',
  admin: true,
  effect: 'write' as const,
  description: 'Remove pipeline instances (cancels running ones first)',
  args: [
    { name: 'id', type: 'string' as const, description: 'Instance ID(s)' },
  ],
  flags: [
    { name: 'f', type: 'bool' as const, description: 'Ignore instances that are not found' },
  ],
};
