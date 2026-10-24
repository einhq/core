import { parseArgs } from '../../../lib/args/mod.ts';
import type { Command } from '../command.ts';
import type { CmdReturn } from '../types.ts';

export const logout = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['session'],
  });

  try {
    await cmd.logout(flags.session);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`login: ${message}\n`);
    return 1;
  }

  if (cmd.json) {
    await cmd.writeJSON({ ok: true });
  }
  return 0;
};

logout.spec = {
  name: 'logout',
  guest: true,
  effect: 'write' as const,
  description: 'Log out of the current session',
  args: [],
  flags: [
    {
      name: 'session',
      type: 'bool' as const,
      description: 'logout session not just shell',
    },
  ],
};
