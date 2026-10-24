import { resolve } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const fileStat = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['f'],
  });
  const flagsPath = flags._[0] as string;
  const path = resolve(cmd.cwd, flagsPath || '.');

  try {
    const stat = flags.f ? await cmd.sys.vfs.statX(cmd.access, path) : await cmd.sys.vfs.stat(cmd.access, path);

    if (cmd.json) {
      await cmd.writeJSON(stat);
    } else {
      if (Object.keys(stat).length > 0) {
        await cmd.writeYAML(stat);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (cmd.json) {
      await cmd.writeJSON({ error: `file-stat: ${message}` });
    } else {
      await cmd.writeError(`file-stat: ${message}\n`);
    }
    return 1;
  }

  return 0;
};

fileStat.spec = {
  name: 'file-stat',
  effect: 'read' as const,
  description: 'Stat for on disk file ',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      description: 'path to node',
    },
  ],
  flags: [
    { name: 'f', type: 'bool' as const, description: 'return full information, including mimetype, sha256, much slower' },
  ],
  examples: [
    'file-stat /archive/albums/Exempelalbum_2019/files/IMG_0007.jpg',
  ],
  returns: "the file's size, mode and times as they are on disk.",
};
