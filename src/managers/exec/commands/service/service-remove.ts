import { SERVICES_PATH } from '../../../../lib/paths.ts';
import { dirname, join } from '@std/path';
import { Command } from '../../command.ts';
import { CmdReturn } from '../../types.ts';

export const serviceRemove = async (cmd: Command): CmdReturn => {
  const serviceName = cmd.args[0];

  if (!serviceName) {
    await cmd.writeError('service remove: missing service name\n');
    return 1;
  }

  const registry = cmd.sys.serviceManager;
  if (!registry) {
    await cmd.writeError('service: service registry not available\n');
    return 1;
  }

  const servicesPath = cmd.env.SERVICES_PATH || SERVICES_PATH;
  const servicePath = join(servicesPath, 'available', serviceName);
  const enabledPath = join(servicesPath, 'enabled', serviceName);

  if (!await cmd.sys.vfs.exists(cmd.access, servicePath, { follow: false })) {
    await cmd.writeError(`service remove: '${serviceName}' not found\n`);
    return 1;
  }

  const instance = registry.get(serviceName);
  if (instance && (instance.status === 'running' || instance.status === 'starting')) {
    await cmd.writeError(`service remove: '${serviceName}' is running, stop it first\n`);
    return 1;
  }

  if (await cmd.sys.vfs.exists(cmd.access, enabledPath, { follow: false })) {
    await cmd.writeError(`service remove: '${serviceName}' is enabled, disable it first\n`);
    return 1;
  }

  try {
    await cmd.sys.vfs.unlink(cmd.access, servicePath, dirname(servicePath), { follow: false });
    if (cmd.json) {
      await cmd.writeJSON({ ok: true });
    } else {
      await cmd.write(`Removed service '${serviceName}'\n`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`service remove: ${message}\n`);
    return 1;
  }
};

serviceRemove.spec = {
  name: 'service-remove',
  admin: true,
  effect: 'write' as const,
  description: 'Remove a service',
  args: [
    {
      name: 'name',
      type: 'string' as const,
      description: 'Service name',
    },
  ],
};
