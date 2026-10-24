import type { Command } from '../../command.ts';
import { CmdReturn } from '../../types.ts';

/** Print the environment. */
export const env = async (cmd: Command): CmdReturn => {
  const entries = Object.entries(cmd.env);

  entries.sort((a, b) => a[0].localeCompare(b[0]));

  for (const [key, value] of entries) {
    await cmd.write(`${key}=${value}\n`);
  }
  return 0;
};

env.spec = {
  name: 'env',
  effect: 'read' as const,
  json: false,
  description: 'Print environment variables',
};
