/**
 * supervisor install — have the supervisor install a service beside EiN: the media service (ems),
 * the language model (llm) or the devices sidecar (devices). It runs on after the command
 * returns; `supervisor status` says how far it got. EiN restarts during it.
 */

import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { asker, askSupervisor } from './client.ts';

export const supervisorInstall = async (cmd: Command): CmdReturn => {
  const name = cmd.args.find((arg) => !arg.startsWith('-'));
  if (!name) {
    await cmd.writeError('supervisor install: name a service: ems, llm or devices\n');
    return 2;
  }
  try {
    await askSupervisor(cmd, 'POST', `/v0/install/${encodeURIComponent(name)}`, { by: asker(cmd) });
  } catch (error) {
    await cmd.writeError(`supervisor install: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (cmd.json) await cmd.writeJSON({ ok: true });
  else await cmd.write(`The supervisor is installing ${name}; supervisor status says how far it got\n`);
  return 0;
};

supervisorInstall.spec = {
  name: 'supervisor-install',
  admin: true,
  effect: 'write' as const,
  description: 'Have the supervisor install a service beside EiN: the media service, the language model or the devices sidecar',
  args: [
    {
      name: 'service',
      type: 'string' as const,
      description: 'ems, llm or devices',
    },
  ],
  examples: ['supervisor install ems'],
};
