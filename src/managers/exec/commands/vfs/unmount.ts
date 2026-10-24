import { resolve } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { updateFstab } from './fstab.ts';

export const unmount = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { boolean: ['save'] });
  const flagsPath = flags._[0] as string;

  if (!flagsPath) {
    await cmd.writeError('unmount: missing path\n');
    return 1;
  }

  const readmount = flagsPath.startsWith('!');
  const strippedPath = readmount ? flagsPath.slice(1) : flagsPath;

  const path = resolve(cmd.cwd, strippedPath);

  if (path === '/') {
    await cmd.writeError("unmount: cannot unmount '/', not allowed");
    return 1;
  }

  try {
    await cmd.sys.vfs.unmount(cmd.access, path, { readmount });
    if (flags.save) await updateFstab(cmd.sys.vfs, cmd.access, `${cmd.env.ETC_PATH}/fstab`, path, undefined);

    if (cmd.json) {
      await cmd.writeJSON({ ok: true });
    } else {
      await cmd.write(`Unmounted '${path}'\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`unmount: cannot unmount '${flagsPath}': ${message}\n`);
    return 1;
  }

  return 0;
};

unmount.spec = {
  name: 'unmount',
  admin: true,
  effect: 'write' as const,
  description: 'Unmount a filesystem',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      description: 'mount point',
    },
  ],
  flags: [
    { name: 'save', type: 'bool' as const, description: 'also remove the mount from /etc/fstab' },
  ],
};
