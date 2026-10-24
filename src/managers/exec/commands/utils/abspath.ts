import { isAbsolute, normalize, resolve } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import type { Command } from '../../command.ts';
import { CmdReturn } from '../../types.ts';

export const abspath = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {});

  let path = flags._[0] as string;

  if (!path) {
    await cmd.writeError('abspath: missing path parameter');
    return 1;
  }

  if (!isAbsolute(path)) {
    path = normalize(resolve(cmd.cwd, path));
  }

  if (cmd.tty) {
    await cmd.writeLn(path);
  } else {
    await cmd.write(path);
  }

  return 0;
};

abspath.spec = {
  name: 'abspath',
  effect: 'read' as const,
  json: false,
  description: 'Ensure path is abspath',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      description: 'the path to make absolute',
    },
  ],
};
