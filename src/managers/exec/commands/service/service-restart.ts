import { Command } from '../../command.ts';
import { CmdReturn } from '../../types.ts';

export const serviceRestart = async (cmd: Command): CmdReturn => {
  const serviceName = cmd.args[0];

  if (!serviceName) {
    await cmd.writeError('service restart: missing service name\n');
    return 1;
  }

  const registry = cmd.sys.serviceManager;
  if (!registry) {
    await cmd.writeError('service: service registry not available\n');
    return 1;
  }

  try {
    await registry.restart(serviceName, cmd.env);
    if (cmd.json) {
      await cmd.writeJSON({ ok: true });
    } else {
      await cmd.write(`Restarted service '${serviceName}'\n`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`service restart: ${message}\n`);
    return 1;
  }
};

serviceRestart.spec = {
  name: 'service-restart',
  admin: true,
  effect: 'write' as const,
  description: 'Restart a service',
  args: [
    {
      name: 'name',
      type: 'string' as const,
      description: 'Service name',
    },
  ],
};
