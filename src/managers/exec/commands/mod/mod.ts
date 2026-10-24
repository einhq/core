import { dispatchSubcommand } from '../dispatch.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const mod = (cmd: Command): CmdReturn => dispatchSubcommand(cmd, 'mod');

mod.spec = {
  name: 'mod',
  json: false,
  description: 'Module management',
  args: [
    {
      name: 'subcommand',
      type: 'subcommand' as const,
      description: 'Subcommand to run',
    },
  ],
  group: true,
};
