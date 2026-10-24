import { dirname, resolve } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../../../vfs/types/directory.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

/**
 * The operand, then with `-p` each parent it names: `a/b/c` gives `a/b/c`, `a/b`, `a`. The root
 * and the working directory (`.`) are never among them.
 */
const removals = (pathArg: string, parents: boolean): string[] => {
  const out = [pathArg];
  if (!parents) return out;

  let path = pathArg.replace(/\/+$/, '');
  for (let parent = dirname(path); parent !== path && parent !== '.' && parent !== '/'; parent = dirname(path)) {
    out.push(parent);
    path = parent;
  }
  return out;
};

export const rmdir = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['p', 'parents'],
    alias: { p: 'parents' },
  });

  const paths = flags._;

  if (paths.length === 0) {
    await cmd.writeError('rmdir: missing operand\n');
    return 1;
  }

  let exitCode = 0;

  for (const operand of paths) {
    for (const pathArg of removals(operand, flags.parents)) {
      const path = resolve(cmd.cwd, pathArg);

      try {
        // A link is not a directory, even when it points at one.
        const node = await cmd.sys.vfs.get(cmd.access, path, { readlink: true });
        if (node.type !== NODE_TYPE_DIRECTORY) {
          throw new Error('Not a directory');
        }
        if (await cmd.sys.vfs.childCount(cmd.access, path, { readlink: true, all: true }) > 0) {
          throw new Error('Directory not empty');
        }

        await cmd.sys.vfs.unlink(cmd.access, path, dirname(path), { readlink: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await cmd.writeError(`rmdir: failed to remove '${pathArg}': ${message}\n`);
        exitCode = 1;
        // With -p, a parent that stays is where the operand stops.
        break;
      }
    }
  }

  if (cmd.json) {
    await cmd.writeJSON({ ok: exitCode === 0 });
  }
  return exitCode;
};

rmdir.spec = {
  name: 'rmdir',
  effect: 'write' as const,
  description: 'Remove empty directories',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      description: 'empty directory node(s) to remove',
    },
  ],
  flags: [
    { name: 'p', type: 'bool' as const, description: 'also remove each parent the path names, as each becomes empty' },
  ],
  examples: [
    'rmdir /home/exempel/tomt',
    'rmdir -p /home/exempel/utkast/2019/juni',
  ],
  returns: 'nothing.',
};
