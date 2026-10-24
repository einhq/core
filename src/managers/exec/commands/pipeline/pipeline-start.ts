import { type CreatedInstance, createInstanceFromDef } from './lib.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const pipelineStart = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { collect: ['var'], string: ['var'] });

  const [rawName, rawPath] = flags._;
  const name = rawName === undefined ? undefined : String(rawName);
  const triggerPath = rawPath === undefined ? undefined : String(rawPath);

  if (!name) {
    await cmd.writeError('pipeline-start: missing pipeline name\n');
    return 1;
  }
  if (!triggerPath) {
    await cmd.writeError('pipeline-start: missing trigger path\n');
    return 1;
  }

  // `--var NAME=VALUE`: overrides one of the definition's declared variables for
  // this run only. The value is substituted as a single shell word, so a flag
  // like `-f` arrives intact and a value with spaces cannot split into two args.
  const vars: Record<string, string> = {};
  for (const entry of flags.var ?? []) {
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      await cmd.writeError(`pipeline-start: --var expects NAME=VALUE, got '${entry}'\n`);
      return 1;
    }
    vars[entry.slice(0, eq)] = entry.slice(eq + 1);
  }

  // createInstanceFromDef enforces one-per-node (removes any prior instance for
  // this file) and creates a fresh one; the engine advances it on the
  // instance-node created event.
  // A hand-started run has no domain event behind it, so a definition whose
  // steps read `$EVENT_*` gets them empty; createInstanceFromDef says which.
  let created: CreatedInstance;
  try {
    created = await createInstanceFromDef(cmd, name, triggerPath, vars);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`pipeline-start: ${message}\n`);
    return 1;
  }

  if (cmd.json) {
    await cmd.writeJSON({
      ok: true,
      id: created.id,
      ...(created.missingEventVars.length > 0 ? { missingEventVars: created.missingEventVars } : {}),
    });
    return 0;
  }

  await cmd.writeLn(created.id);
  return 0;
};

pipelineStart.spec = {
  name: 'pipeline-start',
  admin: true,
  effect: 'write' as const,
  description: 'Manually start a pipeline',
  args: [
    { name: 'name', type: 'string' as const, description: 'Pipeline name' },
    { name: 'path', type: 'path' as const, description: 'Target path to process' },
  ],
  flags: [
    { name: 'var', type: 'string' as const, description: 'Override a declared variable for this run: NAME=VALUE (repeatable)' },
  ],
};
