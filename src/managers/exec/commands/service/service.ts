import { dispatchSubcommand } from '../dispatch.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const service = (cmd: Command): CmdReturn => dispatchSubcommand(cmd, 'service');

service.spec = {
  name: 'service',
  json: false,
  description: 'Manage system services',
  args: [
    {
      name: 'subcommand',
      type: 'subcommand' as const,
      description: 'Subcommand to run',
    },
  ],
  group: true,
};
