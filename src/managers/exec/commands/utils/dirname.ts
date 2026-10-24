import { parseArgs } from '../../../../lib/args/mod.ts';
import type { Command } from '../../command.ts';
import { CmdReturn } from '../../types.ts';

export const dirname = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    alias: {
      z: 'zero',
    },
    boolean: ['z'],
  });

  const paths = flags._ as string[];

  if (paths.length === 0) {
    await cmd.writeError('dirname: missing operand\n');
    return 1;
  }

  const terminator = flags.zero ? '\0' : '\n';

  for (const path of paths) {
    let dir: string;

    const normalized = path.replace(/\/+$/, '');

    if (normalized === '') {
      dir = path.startsWith('/') ? '/' : '.';
    } else {
      const lastSlash = normalized.lastIndexOf('/');

      if (lastSlash === -1) {
        dir = '.';
      } else if (lastSlash === 0) {
        dir = '/';
      } else {
        dir = normalized.slice(0, lastSlash);
        dir = dir.replace(/\/+$/, '') || '/';
      }
    }

    await cmd.write(`${dir}${terminator}`);
  }

  return 0;
};

dirname.spec = {
  name: 'dirname',
  effect: 'read' as const,
  json: false,
  description: 'Strip last component from file name',
  args: [
    {
      name: 'NAME',
      type: 'path' as const,
      description: 'the path to extract directory from',
    },
  ],
  flags: [
    { name: 'z', type: 'bool' as const, description: 'end each output line with NUL, not newline' },
  ],
};
