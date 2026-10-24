import { parseArgs } from '../../../../lib/args/mod.ts';
import { resolve } from '@std/path';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const truncate = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['s'],
    alias: { s: 'size' },
  });
  const flagsPath = flags._[0] as string;

  if (!flagsPath) {
    await cmd.writeError('truncate: missing operand\n');
    return 1;
  }

  const path = resolve(cmd.cwd, flagsPath);
  const size = flags.s !== undefined ? Number.parseInt(flags.s) : 0;

  if (Number.isNaN(size) || size < 0) {
    await cmd.writeError(`truncate: invalid size: '${flags.s}'\n`);
    return 1;
  }

  try {
    const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'w' });
    await handle.close();
    if (cmd.json) {
      await cmd.writeJSON({ ok: true });
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`truncate: ${path}: ${message}\n`);
    return 1;
  }
};

truncate.spec = {
  name: 'truncate',
  effect: 'write' as const,
  description: 'Truncate an associated resource of a node if it has one',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      description: 'path to truncate',
    },
  ],
  flags: [
    {
      name: 's',
      type: 'string' as const,
      description: 'size to truncate to (default: 0)',
    },
  ],
};
