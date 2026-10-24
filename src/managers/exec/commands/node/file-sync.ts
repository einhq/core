import { resolve } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { refineMimeByName } from '../../../../lib/media/mod.ts';
import { NODE_TYPE_FILE } from '../../../../vfs/types/file.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const fileSync = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {});
  const flagsPath = flags._[0] as string;
  const path = resolve(cmd.cwd, flagsPath || '.');

  try {
    const node = await cmd.sys.vfs.get(cmd.access, path);

    if (node.type !== NODE_TYPE_FILE) {
      throw new Error(`node type is not supported: ${node.type}`);
    }

    const stat = await cmd.sys.vfs.statX(cmd.access, path);
    // The registry sniffs bytes it has no name for; a camera RAW or a sidecar is told by its name
    const mimetype = typeof stat.mimetype === 'string' ? refineMimeByName(stat.mimetype, path) : stat.mimetype;

    const updatedNode = await cmd.sys.vfs.update(cmd.access, path, {
      attrs: {
        size: stat.size,
        sha256: stat.sha256,
        mimetype,
      },
    });

    if (cmd.json) {
      await cmd.writeJSON(updatedNode.attrs);
    } else {
      if (Object.keys(updatedNode.attrs).length > 0) {
        await cmd.writeYAML(updatedNode.attrs);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (cmd.json) {
      await cmd.writeJSON({ error: `file-sync: ${message}` });
    } else {
      await cmd.writeError(`file-sync: ${message}\n`);
    }
    return 1;
  }

  return 0;
};

fileSync.spec = {
  name: 'file-sync',
  effect: 'write' as const,
  description: 'Sync for on disk file ',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      description: 'path to node',
    },
  ],
  examples: [
    'file-sync /archive/albums/Exempelalbum_2019/files/IMG_0007.jpg',
  ],
  returns: "nothing; the node's size and checksum are brought in line with the bytes on disk.",
};
