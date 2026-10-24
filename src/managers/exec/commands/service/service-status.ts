import { SERVICES_PATH } from '../../../../lib/paths.ts';
import { join } from '@std/path';
import { Command } from '../../command.ts';
import { CmdReturn } from '../../types.ts';

export const serviceStatus = async (cmd: Command): CmdReturn => {
  const serviceName = cmd.args[0];

  if (!serviceName) {
    await cmd.writeError('service status: missing service name\n');
    return 1;
  }

  const registry = cmd.sys.serviceManager;
  if (!registry) {
    await cmd.writeError('service: service registry not available\n');
    return 1;
  }

  const servicesPath = cmd.env.SERVICES_PATH || SERVICES_PATH;
  const servicePath = join(servicesPath, 'available', serviceName);

  if (!await cmd.sys.vfs.exists(cmd.access, servicePath)) {
    await cmd.writeError(`service: '${serviceName}' not found\n`);
    return 1;
  }

  const info = await registry.getInfo(serviceName);
  const instance = registry.get(serviceName);

  // Where the service's own output went. A service's stdout and stderr are piped into the VFS,
  // so none of it reaches the container's log; naming the paths says where to read it.
  const logsPath = registry.getLogsPath(serviceName);
  const stdoutLog = join(logsPath, 'stdout.log');
  const stderrLog = join(logsPath, 'stderr.log');

  if (cmd.json) {
    await cmd.writeJSON({
      name: info.name,
      status: info.status,
      enabled: info.enabled,
      description: info.description,
      startedAt: instance?.startedAt,
      restartCount: instance?.restartCount,
      lastExitCode: instance?.lastExitCode,
      stdoutLog,
      stderrLog,
    });
    return 0;
  }

  await cmd.write(`Service: ${info.name}\n`);
  await cmd.write(`Status: ${info.status}\n`);
  await cmd.write(`Enabled: ${info.enabled ? 'yes' : 'no'}\n`);
  if (info.description) {
    await cmd.write(`Description: ${info.description}\n`);
  }
  if (instance) {
    await cmd.write(`Started: ${new Date(instance.startedAt).toISOString()}\n`);
    await cmd.write(`Restarts: ${instance.restartCount}\n`);
    if (instance.lastExitCode !== undefined) {
      await cmd.write(`Last exit code: ${instance.lastExitCode}\n`);
    }
  }
  await cmd.write(`Output: ${stdoutLog}\n`);
  await cmd.write(`Errors: ${stderrLog}\n`);

  return 0;
};

serviceStatus.spec = {
  name: 'service-status',
  effect: 'read' as const,
  description: 'Show service status',
  args: [
    {
      name: 'name',
      type: 'string' as const,
      description: 'Service name',
    },
  ],
};
