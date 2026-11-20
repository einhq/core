/**
 * supervisor update — have the supervisor update services beside EiN now, EiN itself among them:
 * each pulled, made again from a new image, and put back on the one it ran when the new one does
 * not come up. Every service with a newer release when none is named, as `supervisor status` lists
 * them. It runs on after the command returns; `supervisor status` says how far it got.
 */

import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { asker, askSupervisor } from './client.ts';

export const supervisorUpdate = async (cmd: Command): CmdReturn => {
  const services = cmd.args.filter((arg) => !arg.startsWith('-'));
  try {
    await askSupervisor(cmd, 'POST', '/v0/update', { by: asker(cmd), ...(services.length > 0 ? { services } : {}) });
  } catch (error) {
    await cmd.writeError(`supervisor update: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (cmd.json) await cmd.writeJSON({ ok: true });
  else {
    await cmd.write(`The supervisor is updating ${services.length > 0 ? services.join(', ') : 'every service with an update'}; supervisor status says how far it got\n`);
  }
  return 0;
};

supervisorUpdate.spec = {
  name: 'supervisor-update',
  admin: true,
  effect: 'write' as const,
  description: 'Have the supervisor update services beside EiN now, EiN among them; every one with a newer release when none is named',
  args: [
    {
      name: 'services',
      type: 'string' as const,
      variadic: true,
      description: 'core, db, ems, llm, devices or supervisor',
    },
  ],
  examples: ['supervisor update', 'supervisor update core db'],
};
