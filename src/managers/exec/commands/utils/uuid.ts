import type { Command } from '../../command.ts';
import { CmdReturn } from '../../types.ts';

export const uuid = async (cmd: Command): CmdReturn => {
  await cmd.write(`${crypto.randomUUID()}\n`);
  return 0;
};

uuid.spec = {
  name: 'uuid',
  effect: 'read' as const,
  json: false,
  description: 'Generate a random UUID',
  args: [],
  flags: [],
};
