import { SERVICES_PATH } from '../../../../lib/paths.ts';
import { basename, dirname, join } from '@std/path';
import { NODE_TYPE_DIRECTORY } from '../../../../vfs/types/directory.ts';
import { NODE_TYPE_SOFTLINK } from '../../../../vfs/types/softlink.ts';
import { Command } from '../../command.ts';
import { CmdReturn } from '../../types.ts';

export const serviceAdd = async (cmd: Command): CmdReturn => {
  const serviceName = cmd.args[0];
  const scriptPath = cmd.args[1];

  if (!serviceName) {
    await cmd.writeError('service add: missing service name\n');
    await cmd.writeError('usage: service add <name> <path>\n');
    return 1;
  }

  if (!scriptPath) {
    await cmd.writeError('service add: missing path to service script directory\n');
    await cmd.writeError('usage: service add <name> <path>\n');
    return 1;
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(serviceName)) {
    await cmd.writeError(
      'service add: invalid service name (use alphanumeric, dash, underscore)\n',
    );
    return 1;
  }

  const servicesPath = cmd.env.SERVICES_PATH || SERVICES_PATH;
  const availableDir = join(servicesPath, 'available');
  const servicePath = join(availableDir, serviceName);

  if (!await cmd.sys.vfs.exists(cmd.access, scriptPath)) {
    await cmd.writeError(`service add: '${scriptPath}' not found\n`);
    return 1;
  }

  const startScript = join(scriptPath, 'start.sh');
  if (!await cmd.sys.vfs.exists(cmd.access, startScript)) {
    await cmd.writeError(`service add: '${scriptPath}' has no start.sh\n`);
    return 1;
  }

  try {
    if (await cmd.sys.vfs.exists(cmd.access, servicePath, { follow: false })) {
      const existing = await cmd.sys.vfs.get(cmd.access, servicePath, { follow: false });
      if (existing.type !== NODE_TYPE_SOFTLINK) {
        await cmd.writeError(`service add: '${serviceName}' already exists and is not a service link\n`);
        return 1;
      }

      if (existing.props.softlink !== scriptPath) {
        await cmd.sys.vfs.update(cmd.access, servicePath, {
          follow: false,
          props: { softlink: scriptPath },
        });
      }

      if (cmd.json) {
        await cmd.writeJSON({ ok: true });
      } else if (existing.props.softlink === scriptPath) {
        await cmd.write(`Service '${serviceName}' already points to ${scriptPath}\n`);
      } else {
        await cmd.write(`Updated service '${serviceName}' -> ${scriptPath}\n`);
      }
      return 0;
    }

    await cmd.sys.vfs.ensure(cmd.access, NODE_TYPE_DIRECTORY, dirname(servicesPath), basename(servicesPath));
    await cmd.sys.vfs.ensure(cmd.access, NODE_TYPE_DIRECTORY, servicesPath, 'available');

    await cmd.sys.vfs.create(
      cmd.access,
      NODE_TYPE_SOFTLINK,
      availableDir,
      serviceName,
      {
        props: {
          uid: cmd.access.uid,
          gid: cmd.access.gid,
          mode: 0o777,
          softlink: scriptPath,
        },
      },
    );

    if (cmd.json) {
      await cmd.writeJSON({ ok: true });
    } else {
      await cmd.write(`Added service '${serviceName}' -> ${scriptPath}\n`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`service add: ${message}\n`);
    return 1;
  }
};

serviceAdd.spec = {
  name: 'service-add',
  admin: true,
  effect: 'write' as const,
  description: 'Add a service by linking to a service script directory',
  args: [
    {
      name: 'name',
      type: 'string' as const,
      description: 'Service name',
    },
    {
      name: 'path',
      type: 'string' as const,
      description: 'Path to service script directory (must contain start.sh)',
    },
  ],
};
