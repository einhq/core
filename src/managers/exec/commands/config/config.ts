import { dispatchSubcommand } from '../dispatch.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const config = (cmd: Command): CmdReturn => dispatchSubcommand(cmd, 'config');

config.spec = {
  name: 'config',
  guest: true,
  json: false,
  description: 'Read and change system and personal settings',
  args: [
    {
      name: 'subcommand',
      type: 'subcommand' as const,
      description: 'Subcommand to run',
    },
  ],
  group: true,
};
