import { Command } from '../../command.ts';
import { CmdReturn } from '../../types.ts';

export const serviceStartAll = async (cmd: Command): CmdReturn => {
  const registry = cmd.sys.serviceManager;
  if (!registry) {
    await cmd.writeError('service: service registry not available\n');
    return 1;
  }

  const enabled = await registry.listEnabled();

  if (enabled.length === 0) {
    if (cmd.json) {
      await cmd.writeJSON({ ok: true, started: 0 });
    } else {
      await cmd.write('No enabled services to start\n');
    }
    return 0;
  }

  if (!cmd.json) {
    await cmd.write(`Starting ${enabled.length} enabled service(s)...\n`);
  }
  await registry.startAll(cmd.env);
  if (cmd.json) {
    await cmd.writeJSON({ ok: true, started: enabled.length });
  } else {
    await cmd.write('Done\n');
  }
  return 0;
};

serviceStartAll.spec = {
  name: 'service-start-all',
  admin: true,
  effect: 'write' as const,
  description: 'Start all enabled services',
  args: [],
};
