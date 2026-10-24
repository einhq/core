import { resolve } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const props = async (cmd: Command): CmdReturn => {
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
      await cmd.writeJSON(node.props);
    } else {
      if (Object.keys(node.props).length > 0) {
        await cmd.writeYAML(node.props);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`props: ${path}: ${message}\n`);
    return 1;
  }

  return 0;
};

props.spec = {
  name: 'props',
  effect: 'read' as const,
  description: 'Display node properties',
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
