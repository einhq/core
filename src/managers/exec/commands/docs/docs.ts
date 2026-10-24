import { dispatchSubcommand } from '../dispatch.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const docs = (cmd: Command): CmdReturn => dispatchSubcommand(cmd, 'docs');

docs.spec = {
  name: 'docs',
  json: false,
  description: 'Describe what this installation is made of: its commands, node types and environment variables',
  args: [
    {
      name: 'subcommand',
      type: 'subcommand' as const,
      description: 'Subcommand to run',
    },
  ],
  group: true,
};
