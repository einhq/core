import { resolve } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const info = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['L'],
  });

  const path = resolve(cmd.cwd, flags._[0] as string || '.');

  const resolveOpts = {
    readlink: flags.L,
  };

  try {
    const node = await cmd.sys.vfs.get(cmd.access, path, resolveOpts);

    const info = {
      id: node.id,
      type: node.type,
    };

    if (cmd.json) {
      await cmd.writeJSON(info);
    } else {
      await cmd.writeYAML(info);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`info: ${path}: ${message}\n`);
    return 1;
  }

  return 0;
};

info.spec = {
  name: 'info',
  effect: 'read' as const,
  description: 'Display node ID and type',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      description: 'path to node',
    },
  ],
  flags: [
    { name: 'L', type: 'bool' as const, description: 'do not follow symbolic links' },
  ],
};
