import { SERVICES_PATH } from '../../../../lib/paths.ts';
import { dirname, join } from '@std/path';
import { Command } from '../../command.ts';
import { CmdReturn } from '../../types.ts';

export const serviceDisable = async (cmd: Command): CmdReturn => {
  const serviceName = cmd.args[0];

  if (!serviceName) {
    await cmd.writeError('service disable: missing service name\n');
    return 1;
  }

  const servicesPath = cmd.env.SERVICES_PATH || SERVICES_PATH;
  const enabledPath = join(servicesPath, 'enabled', serviceName);

  if (!await cmd.sys.vfs.exists(cmd.access, enabledPath, { follow: false })) {
    if (cmd.json) {
      await cmd.writeJSON({ ok: true });
    } else {
      await cmd.write(`Service '${serviceName}' is already disabled\n`);
    }
    return 0;
  }

  try {
    await cmd.sys.vfs.unlink(cmd.access, enabledPath, dirname(enabledPath), { readlink: true });
    if (cmd.json) {
      await cmd.writeJSON({ ok: true });
    } else {
      await cmd.write(`Disabled service '${serviceName}'\n`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`service disable: ${message}\n`);
    return 1;
  }
};

serviceDisable.spec = {
  name: 'service-disable',
  admin: true,
  effect: 'write' as const,
  description: 'Disable a service',
  args: [
    {
      name: 'name',
      type: 'string' as const,
      description: 'Service name',
    },
  ],
};
