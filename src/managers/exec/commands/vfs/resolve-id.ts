import { parseArgs } from '../../../../lib/args/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const resolveId = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {});

  const id = flags._[0] as string;

  try {
    const entries = await cmd.sys.vfs.resolveId(cmd.access, id);

    if (cmd.json) {
      await cmd.writeJSON(entries.map((e) => ({ id: e.id, path: e.absPath })));
    } else {
      for (const e of entries) {
        await cmd.write(`${e.absPath}\n`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (cmd.json) {
      await cmd.writeJSON({ error: `resolve-id: ${message}` });
    } else {
      await cmd.writeError(`resolve-id: ${message}\n`);
    }
    return 1;
  }

  return 0;
};

resolveId.spec = {
  name: 'resolve-id',
  effect: 'read' as const,
  description: 'Resolve node ID to path',

  args: [
    {
      name: 'id',
      type: 'string' as const,
      description: 'id of node',
    },
  ],
  flags: [],
};
