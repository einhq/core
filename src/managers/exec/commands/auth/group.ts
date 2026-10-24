import { dispatchSubcommand } from '../dispatch.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const group = (cmd: Command): CmdReturn => dispatchSubcommand(cmd, 'group');

group.spec = {
  name: 'group',
  json: false,
  description: 'Manage groups',
  args: [
    {
      name: 'subcommand',
      type: 'subcommand' as const,
      description: 'Subcommand to run',
    },
  ],
  group: true,
};
