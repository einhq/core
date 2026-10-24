import { dispatchSubcommand } from '../dispatch.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const pipeline = (cmd: Command): CmdReturn => dispatchSubcommand(cmd, 'pipeline');

pipeline.spec = {
  name: 'pipeline',
  json: false,
  description: 'Manage pipelines',
  args: [
    {
      name: 'subcommand',
      type: 'subcommand' as const,
      description: 'Subcommand to run',
    },
  ],
  group: true,
};
