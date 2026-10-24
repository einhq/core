import { dispatchSubcommand } from '../dispatch.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const pool = (cmd: Command): CmdReturn => dispatchSubcommand(cmd, 'pool');

pool.spec = {
  name: 'pool',
  json: false,
  description: 'Manage work pools',
  args: [
    {
      name: 'subcommand',
      type: 'subcommand' as const,
      description: 'Subcommand to run',
    },
  ],
  group: true,
};
