import type { Command } from '../../command.ts';
import { CmdReturn } from '../../types.ts';

export const clear = async (cmd: Command): CmdReturn => {
  await cmd.clearScreen();
  return 0;
};

clear.spec = {
  name: 'clear',
  effect: 'read' as const,
  json: false,
  description: 'Clear the terminal screen',
  args: [],
  flags: [],
};
