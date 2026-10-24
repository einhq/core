import { basename, dirname, resolve } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const cp = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['r', 'R', 'recursive', 'f', 'force'],
    alias: {
      r: 'recursive',
      R: 'recursive',
      f: 'force',
    },
  });

  const args = flags._ as string[];

  if (args.length < 2) {
    await cmd.writeError('cp: missing file operand\n');
    await cmd.writeError('Usage: cp [-r] SOURCE DEST\n');
    return 1;
  }

  const sourceArgs = args.slice(0, -1);
  const destArg = args.at(-1)!;

  const recursive = flags.recursive;
  const force = flags.force;

  const destPath = resolve(cmd.cwd, destArg);
  const destExists = await cmd.sys.vfs.exists(cmd.access, destPath);

  if (sourceArgs.length > 1 && !destExists) {
    await cmd.writeError(`cp: target '${destArg}' is not an existing node\n`);
    return 1;
  }

  let exitCode = 0;
  for (const sourceArg of sourceArgs) {
    const sourcePath = resolve(cmd.cwd, sourceArg);
    try {
      if (!await cmd.sys.vfs.exists(cmd.access, sourcePath)) {
        await cmd.writeError(`cp: cannot stat '${sourceArg}': No such file or directory\n`);
        exitCode = 1;
        continue;
      }

      let destParent: string;
      let destName: string;
      if (destExists) {
        destParent = destPath;
        destName = basename(sourcePath);
      } else {
        destParent = dirname(destPath);
        destName = basename(destPath);

        if (!await cmd.sys.vfs.exists(cmd.access, destParent)) {
          await cmd.writeError(`cp: cannot create '${destArg}': No such file or directory\n`);
          return 1;
        }
      }

      await cmd.sys.vfs.copy(
        cmd.access,
        sourcePath,
        destParent,
        destName,
        { recursive, overwrite: force },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await cmd.writeError(`cp: ${message}\n`);
      exitCode = 1;
    }
  }

  if (cmd.json) await cmd.writeJSON({ ok: exitCode === 0 });
  return exitCode;
};

cp.spec = {
  name: 'cp',
  effect: 'write' as const,
  description: 'Copy files and directories',
  args: [
    {
      name: 'source',
      type: 'path' as const,
      description: 'source file(s) or directories to copy',
    },
    {
      name: 'dest',
      type: 'path' as const,
      description: 'destination path',
    },
  ],
  flags: [
    { name: 'r', type: 'bool' as const, description: 'copy directories recursively' },
    { name: 'f', type: 'bool' as const, description: 'overwrite existing destination files' },
  ],
  examples: [
    'cp /archive/albums/Exempelalbum_2019/files/IMG_0007.jpg /archive/albums/Exempelalbum_2019/files/IMG_0007_copy.jpg',
    'cp -r /archive/albums/Exempelalbum_A /archive/albums/Exempelalbum_B',
  ],
  returns: 'nothing.',
};
