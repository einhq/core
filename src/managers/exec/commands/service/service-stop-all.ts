import { Command } from '../../command.ts';
import { CmdReturn } from '../../types.ts';

export const serviceStopAll = async (cmd: Command): CmdReturn => {
  const registry = cmd.sys.serviceManager;
  if (!registry) {
    await cmd.writeError('service: service registry not available\n');
    return 1;
  }

  if (!cmd.json) {
    await cmd.write('Stopping all running services...\n');
  }
  await registry.stopAll();
  if (cmd.json) {
    await cmd.writeJSON({ ok: true });
  } else {
    await cmd.write('Done\n');
  }
  return 0;
};

serviceStopAll.spec = {
  name: 'service-stop-all',
  admin: true,
  effect: 'write' as const,
  description: 'Stop all running services',
  args: [],
};
