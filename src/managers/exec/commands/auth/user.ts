import { dispatchSubcommand } from '../dispatch.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const user = (cmd: Command): CmdReturn => dispatchSubcommand(cmd, 'user');

user.spec = {
  name: 'user',
  json: false,
  description: 'Manage users',
  args: [
    {
      name: 'subcommand',
      type: 'subcommand' as const,
      description: 'Subcommand to run',
    },
  ],
  group: true,
};
