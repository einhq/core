import { basename, dirname, resolve } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { NODE_TYPE_FILE } from '../../../../vfs/types/file.ts';
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

  const args = flags._;

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
  const dest = await cmd.sys.vfs.exists(cmd.access, destPath) ? await cmd.sys.vfs.get(cmd.access, destPath) : undefined;
  // Any node can hold children, so an existing DEST holds the copies as a directory does, unless
  // it is a file: a file named as DEST is the one the copy replaces.
  const into = dest !== undefined && dest.type !== NODE_TYPE_FILE;
  const replace = dest !== undefined && !into;

  if (replace && destArg.endsWith('/')) {
    await cmd.writeError(`cp: cannot copy to '${destArg}': Not a directory\n`);
    return 1;
  }
  if (sourceArgs.length > 1 && !into) {
    await cmd.writeError(dest ? `cp: target '${destArg}' is not a directory\n` : `cp: target '${destArg}' is not an existing node\n`);
    return 1;
  }
  if (!dest && !await cmd.sys.vfs.exists(cmd.access, dirname(destPath))) {
    await cmd.writeError(`cp: cannot create '${destArg}': No such file or directory\n`);
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

      if (replace) {
        const source = await cmd.sys.vfs.get(cmd.access, sourcePath);
        if (source.id === dest!.id) {
          await cmd.writeError(`cp: '${sourceArg}' and '${destArg}' are the same file\n`);
          exitCode = 1;
          continue;
        }
        if (source.type !== NODE_TYPE_FILE) {
          await cmd.writeError(`cp: cannot overwrite file '${destArg}' with '${sourceArg}', which is not a file\n`);
          exitCode = 1;
          continue;
        }
      }

      await cmd.sys.vfs.copy(
        cmd.access,
        sourcePath,
        into ? destPath : dirname(destPath),
        into ? basename(sourcePath) : basename(destPath),
        // A file named as DEST is replaced, as cp replaces it; a name taken inside DEST only with -f.
        { recursive, overwrite: force || replace },
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
      description: 'destination: an existing directory (or other node that is not a file) to copy into, or the path of a single source, replacing a file there',
    },
  ],
  flags: [
    { name: 'r', type: 'bool' as const, description: 'copy directories recursively' },
    { name: 'f', type: 'bool' as const, description: 'replace a node of the same name in the destination directory; a file named as DEST is replaced without it' },
  ],
  examples: [
    'cp /archive/albums/Exempelalbum_2019/files/IMG_0007.jpg /archive/albums/Exempelalbum_2019/files/IMG_0007_copy.jpg',
    'cp -r /archive/albums/Exempelalbum_A /archive/albums/Exempelalbum_B',
  ],
  returns: 'nothing.',
};
