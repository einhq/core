import { parseArgs } from '../../../lib/args/mod.ts';
import { accountByLoginName } from '../../../lib/auth/email.ts';
import type { Command } from '../command.ts';
import type { CmdReturn } from '../types.ts';

export const login = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['session'],
  });
  const username = flags._[0] as string;
  const passwordArg = flags._[1] as string | undefined;

  if (!username) {
    await cmd.writeError('login: missing username\n');
    return 1;
  }

  const password = passwordArg ?? await cmd.prompt('Password: ', 'secret', 'give the password after the username');

  try {
    await cmd.login(username, password, flags.session);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`login: ${message}\n`);
    return 1;
  }

  if (cmd.json) {
    // The account's own name, also when it was named by its e-mail address.
    const account = await accountByLoginName(cmd.sys.vfs, username);
    await cmd.writeJSON({ success: true, username: account?.username ?? username });
  }

  return 0;
};

login.spec = {
  name: 'login',
  guest: true,
  effect: 'write' as const,
  description: 'Authenticate as a user',
  args: [
    {
      name: 'username',
      type: 'user' as const,
      description: 'user to login: a username, or the e-mail address of an account',
    },
    {
      name: 'password',
      type: 'string' as const,
      description: 'password (optional, prompts if not provided)',
    },
  ],
  flags: [
    {
      name: 'session',
      type: 'bool' as const,
      description: 'login session not just shell',
    },
  ],
};
