import type { SignedOut } from '../../../lib/api/users.ts';
import { parseArgs } from '../../../lib/args/mod.ts';
import type { Command } from '../command.ts';
import type { CmdReturn } from '../types.ts';

export const logout = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['session'],
  });

  let handover: string | undefined;
  try {
    handover = await cmd.logout(flags.session);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`logout: ${message}\n`);
    return 1;
  }

  if (cmd.json) {
    await cmd.writeJSON({ ok: true, ...(handover ? { handover } : {}) } satisfies SignedOut);
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
      description: 'sign the session out, not just this shell; it gets a new secret, whose handover token the JSON answer carries',
    },
  ],
};
