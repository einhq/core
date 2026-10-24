import { SERVICES_PATH } from '../../../../lib/paths.ts';
import { join } from '@std/path';
import { Command } from '../../command.ts';
import { CmdReturn } from '../../types.ts';

export const serviceStart = async (cmd: Command): CmdReturn => {
  const serviceName = cmd.args[0];

  if (!serviceName) {
    await cmd.writeError('service start: missing service name\n');
    return 1;
  }

  const registry = cmd.sys.serviceManager;
  if (!registry) {
    await cmd.writeError('service: service registry not available\n');
    return 1;
  }

  const servicesPath = cmd.env.SERVICES_PATH || SERVICES_PATH;
  const enabledPath = join(servicesPath, 'enabled', serviceName);

  if (!await cmd.sys.vfs.exists(cmd.access, enabledPath, { follow: false })) {
    await cmd.writeError(`service start: '${serviceName}' is not enabled\n`);
    await cmd.writeError(`Use 'service enable ${serviceName}' first\n`);
    return 1;
  }

  try {
    await registry.start(serviceName, cmd.env);
    if (cmd.json) {
      await cmd.writeJSON({ ok: true });
    } else {
      await cmd.write(`Started service '${serviceName}'\n`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`service start: ${message}\n`);
    return 1;
  }
};

serviceStart.spec = {
  name: 'service-start',
  admin: true,
  effect: 'write' as const,
  description: 'Start a service',
  args: [
    {
      name: 'name',
      type: 'string' as const,
      description: 'Service name',
    },
  ],
};
