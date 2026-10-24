import { basename, dirname, resolve } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { NODE_TYPE_SOFTLINK } from '../../../../vfs/types/softlink.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const ln = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['s', 'symbolic', 'f', 'force'],
    alias: {
      s: 'symbolic',
      f: 'force',
    },
  });

  const args = flags._ as string[];

  if (args.length < 2) {
    await cmd.writeError('ln: missing file operand\n');
    await cmd.writeError('Usage: ln [-s] TARGET LINK_NAME\n');
    return 1;
  }

  const targetArg = args[0];
  const linkArg = args[1];

  const isSymbolic = flags.symbolic;
  const force = flags.force;

  const linkPath = resolve(cmd.cwd, linkArg);
  const linkParent = dirname(linkPath);
  const linkName = basename(linkPath);

  try {
    const linkExists = await cmd.sys.vfs.exists(cmd.access, linkPath, { follow: false });
    if (linkExists) {
      if (force) {
        await cmd.sys.vfs.unlink(cmd.access, linkPath, linkParent, { readlink: true });
      } else {
        await cmd.writeError(`ln: failed to create link '${linkArg}': File exists\n`);
        return 1;
      }
    }

    if (isSymbolic) {
      // The target is stored as given, relative or absolute.
      await cmd.sys.vfs.create(
        cmd.access,
        NODE_TYPE_SOFTLINK,
        linkParent,
        linkName,
        {
          props: {
            uid: cmd.access.uid,
            gid: cmd.access.gid,
            mode: 0o777,
            softlink: targetArg,
          },
        },
      );
    } else {
      // A hard link: the existing node is linked into the new parent.
      const targetPath = resolve(cmd.cwd, targetArg);

      const targetExists = await cmd.sys.vfs.exists(cmd.access, targetPath);
      if (!targetExists) {
        await cmd.writeError(`ln: failed to access '${targetArg}': No such file or directory\n`);
        return 1;
      }

      await cmd.sys.vfs.link(cmd.access, targetPath, linkParent, linkName);
    }

    if (cmd.json) {
      await cmd.writeJSON({ ok: true });
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`ln: ${message}\n`);
    return 1;
  }
};

ln.spec = {
  name: 'ln',
  effect: 'write' as const,
  description: 'Create links between files',
  args: [
    {
      name: 'target',
      type: 'path' as const,
      description: 'target of the link',
    },
    {
      name: 'link_name',
      type: 'path' as const,
      description: 'name of the link to create',
    },
  ],
  flags: [
    { name: 's', type: 'bool' as const, description: 'make symbolic links instead of hard links' },
    { name: 'f', type: 'bool' as const, description: 'remove existing destination files' },
  ],
  examples: [
    'ln -s /archive/albums/Exempelalbum_2019/files/IMG_0007.jpg /home/anna/favourite.jpg',
  ],
  returns: 'nothing.',
};
