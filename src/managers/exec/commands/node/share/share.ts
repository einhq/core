import { dispatchSubcommand } from '../../dispatch.ts';
import type { Command } from '../../../command.ts';
import type { CmdReturn } from '../../../types.ts';

export const share = (cmd: Command): CmdReturn => dispatchSubcommand(cmd, 'share');

share.spec = {
  name: 'share',
  json: false,
  description: 'Show and set who has access to a node',
  args: [
    {
      name: 'subcommand',
      type: 'subcommand' as const,
      description: 'Subcommand to run',
    },
  ],
  group: true,
};
