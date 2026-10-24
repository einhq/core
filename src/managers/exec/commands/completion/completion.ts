import { dispatchSubcommand } from '../dispatch.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

/**
 * The spec-driven completion helpers as a group: `completion arg ls --word=b`
 * is `completion-arg`. Named `completion` rather than `complete`, which is
 * bash's builtin for defining completions.
 */
export const completion = (cmd: Command): CmdReturn => dispatchSubcommand(cmd, 'completion');

completion.spec = {
  name: 'completion',
  json: false,
  description: 'Spec-driven completion helpers',
  args: [
    {
      name: 'subcommand',
      type: 'subcommand' as const,
      description: 'Subcommand to run',
    },
  ],
  group: true,
};
