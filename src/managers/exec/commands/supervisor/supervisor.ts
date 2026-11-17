import { dispatchSubcommand } from '../dispatch.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const supervisor = (cmd: Command): CmdReturn => dispatchSubcommand(cmd, 'supervisor');

supervisor.spec = {
  name: 'supervisor',
  json: false,
  description: 'The services beside EiN, which the supervisor installs and updates',
  args: [
    {
      name: 'subcommand',
      type: 'subcommand' as const,
      description: 'Subcommand to run',
    },
  ],
  group: true,
};
