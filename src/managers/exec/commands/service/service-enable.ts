import { SERVICES_PATH } from '../../../../lib/paths.ts';
import { basename, dirname, join } from '@std/path';
import { NODE_TYPE_DIRECTORY } from '../../../../vfs/types/directory.ts';
import { NODE_TYPE_SOFTLINK } from '../../../../vfs/types/softlink.ts';
import { Command } from '../../command.ts';
import { CmdReturn } from '../../types.ts';

export const serviceEnable = async (cmd: Command): CmdReturn => {
  const serviceName = cmd.args[0];

  if (!serviceName) {
    await cmd.writeError('service enable: missing service name\n');
    return 1;
  }

  const servicesPath = cmd.env.SERVICES_PATH || SERVICES_PATH;
  const servicePath = join(servicesPath, 'available', serviceName);
  const enabledPath = join(servicesPath, 'enabled', serviceName);

  if (!await cmd.sys.vfs.exists(cmd.access, servicePath)) {
    await cmd.writeError(`service enable: '${serviceName}' not found\n`);
    return 1;
  }

  if (await cmd.sys.vfs.exists(cmd.access, enabledPath, { follow: false })) {
    if (cmd.json) {
      await cmd.writeJSON({ ok: true });
    } else {
      await cmd.write(`Service '${serviceName}' is already enabled\n`);
    }
    return 0;
  }

  try {
    await cmd.sys.vfs.ensure(cmd.access, NODE_TYPE_DIRECTORY, servicesPath, 'enabled');

    // enabled/<name> -> ../available/<name>
    await cmd.sys.vfs.create(
      cmd.access,
      NODE_TYPE_SOFTLINK,
      dirname(enabledPath),
      basename(enabledPath),
      {
        props: {
          uid: cmd.access.uid,
          gid: cmd.access.gid,
          mode: 0o777,
          softlink: `../available/${serviceName}`,
        },
      },
    );
    if (cmd.json) {
      await cmd.writeJSON({ ok: true });
    } else {
      await cmd.write(`Enabled service '${serviceName}'\n`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`service enable: ${message}\n`);
    return 1;
  }
};

serviceEnable.spec = {
  name: 'service-enable',
  admin: true,
  effect: 'write' as const,
  description: 'Enable a service',
  args: [
    {
      name: 'name',
      type: 'string' as const,
      description: 'Service name',
    },
  ],
};
