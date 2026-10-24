import type { Command } from '../../command.ts';
import { operands } from '../../input.ts';
import { signalExitCode } from '../../signal.ts';
import { CmdReturn } from '../../types.ts';

export const rev = async (cmd: Command): CmdReturn => {
  const inputs = operands(cmd, cmd.args);
  for await (const input of inputs) {
    for await (const line of input.lines()) await cmd.write(`${[...line].reverse().join('')}\n`);
  }
  if (cmd.interrupted) return signalExitCode(cmd.signal ?? 'SIGINT');
  return inputs.failed ? 1 : 0;
};

rev.spec = {
  name: 'rev',
  effect: 'read' as const,
  json: false,
  description: 'Reverse lines character-wise',
  args: [
    {
      name: 'FILE',
      type: 'path' as const,
      description: 'files to reverse, one after the other (stdin if omitted, or for -)',
      variadic: true,
    },
  ],
  flags: [],
};
