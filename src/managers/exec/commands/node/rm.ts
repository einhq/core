import { dirname, resolve } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const rm = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    // `-d` is accepted for GNU compatibility: without `-r`, rm already removes an empty directory.
    boolean: ['r', 'R', 'recursive', 'f', 'force', 'd', 'dir'],
    alias: {
      r: 'recursive',
      R: 'recursive',
      f: 'force',
      d: 'dir',
    },
  });

  const paths = flags._;

  if (paths.length === 0) {
    await cmd.writeError('rm: missing operand\n');
    return 1;
  }

  const recursive = flags.recursive;
  const force = flags.force;

  let exitCode = 0;

  for (const pathArg of paths) {
    const path = resolve(cmd.cwd, pathArg);
    const parentPath = dirname(path);

    try {
      // A non-recursive removal needs the child count. Recursive unlink performs
      // the corresponding checks while it drains the tree, and either reports a
      // missing path itself.
      if (!recursive) {
        if (await cmd.sys.vfs.childCount(cmd.access, path, { readlink: true, all: true }) > 0) {
          await cmd.writeError(`rm: cannot remove '${pathArg}': Node not empty\n`);
          exitCode = 1;
          continue;
        }
      }

      await cmd.sys.vfs.unlink(cmd.access, path, parentPath, {
        recursive,
        readlink: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!force) {
        await cmd.writeError(`rm: cannot remove '${pathArg}': ${message}\n`);
        exitCode = 1;
      }
    }
  }

  if (cmd.json) {
    await cmd.writeJSON({ ok: exitCode === 0 });
  }
  return exitCode;
};

rm.spec = {
  name: 'rm',
  effect: 'write' as const,
  description: 'Remove (delete) files or directories',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      description: 'node(s) to remove',
    },
  ],
  flags: [
    { name: 'r', type: 'bool' as const, description: 'remove nodes and their contents recursively' },
    { name: 'f', type: 'bool' as const, description: 'ignore nonexistent nodes and arguments' },
    { name: 'd', type: 'bool' as const, description: 'remove empty directories (what rm without -r already does)' },
  ],
  examples: [
    'rm /archive/albums/Exempelalbum_2019/files/IMG_0007.jpg',
    'rm -r /archive/albums/Tomt_Exempelalbum',
  ],
  returns: 'nothing.',
};
