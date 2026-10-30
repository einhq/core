import type { UserElevated } from '../../../../lib/api/users.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const userElevate = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['session', 'off'],
    string: ['password'],
  });

  try {
    if (flags.off) {
      await cmd.unelevate(flags.session);
    } else {
      await cmd.elevate(flags.password ?? await cmd.prompt('Password: ', 'secret', 'add --password'), flags.session);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`user elevate: ${message}\n`);
    return 1;
  }

  if (cmd.json) {
    await cmd.writeJSON({ elevated: !flags.off } satisfies UserElevated);
  } else {
    const what = flags.session ? 'This sign-in' : 'This shell';
    const off = flags.session ? 'user-elevate --off --session' : 'user-elevate --off';
    await cmd.write(flags.off ? `${what} is no longer an administrator's\n` : `${what} is an administrator's until you sign out or run ${off}\n`);
  }

  return 0;
};

userElevate.spec = {
  name: 'user-elevate',
  effect: 'write' as const,
  description: "Make this shell an administrator's, or with --session the whole sign-in, for a member of the sudo group, after entering the password again",
  flags: [
    {
      name: 'password',
      type: 'string' as const,
      description: 'your own password (prompts if not given); --password=<value> for one starting with a dash',
    },
    {
      name: 'session',
      type: 'bool' as const,
      description: "the session's sign-in, every page and terminal of it, not just this shell's",
    },
    {
      name: 'off',
      type: 'bool' as const,
      description: "make the shell, or with --session the sign-in, no longer an administrator's",
    },
  ],
};
