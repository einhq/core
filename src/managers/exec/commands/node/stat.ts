import { resolve } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const stat = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['L'],
  });

  const path = resolve(cmd.cwd, flags._[0] as string || '.');

  const resolveOpts = {
    readlink: flags.L,
  };

  try {
    const node = await cmd.sys.vfs.get(cmd.access, path, resolveOpts);

    if (cmd.json) {
      await cmd.writeJSON(node);
    } else {
      await cmd.writeYAML(node);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`stat: ${path}: ${message}\n`);
    return 1;
  }

  return 0;
};

stat.spec = {
  name: 'stat',
  effect: 'read' as const,
  description: 'Display file or node status',
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
  examples: [
    'stat /archive/albums/Exempelalbum_2019/files/IMG_0007.jpg',
  ],
  returns: "the node's type, size, mode, owner and times.",
};
