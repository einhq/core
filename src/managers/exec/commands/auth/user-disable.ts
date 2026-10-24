import type { UserInactive } from '../../../../lib/api/users.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { userRole } from '../../../../lib/auth/roles.ts';
import { UserAttrs } from '../../../../vfs/types/user.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { endSessionsOf } from './sessions.ts';

export const userDisable = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {});
  const username = flags._[0] as string;

  if (!username) {
    await cmd.writeError('user disable: missing username\n');
    return 1;
  }

  const userPath = `${cmd.env.USERS_PATH}/${username}`;

  try {
    const user = await cmd.sys.vfs.get<UserAttrs>(cmd.access, userPath);
    if (!user) {
      await cmd.writeError(`user disable: user '${username}' not found\n`);
      return 1;
    }

    // The system's own shells and services run as the administrator, and a visitor who has not
    // signed in browses as the guest.
    const role = userRole(username, user.attrs.uid);
    if (role === 'administrator') {
      await cmd.writeError(`user disable: cannot disable the administrator\n`);
      return 1;
    }
    if (role === 'guest') {
      await cmd.writeError(`user disable: cannot disable the guest account\n`);
      return 1;
    }

    if (user.attrs.inactive) {
      await cmd.writeError(`user disable: user '${username}' is already inactive\n`);
      return 1;
    }

    await cmd.sys.vfs.update<UserAttrs>(cmd.access, userPath, {
      attrs: { inactive: true },
    });
    await endSessionsOf(cmd, user.attrs.uid);

    if (cmd.json) {
      await cmd.writeJSON({ username, inactive: true } satisfies UserInactive);
    } else {
      await cmd.write(`User '${username}' disabled\n`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`user disable: ${message}\n`);
    return 1;
  }
};

userDisable.spec = {
  name: 'user-disable',
  admin: true,
  effect: 'write' as const,
  description: 'Disable a user account and end its open sessions',
  args: [
    {
      name: 'username',
      type: 'user' as const,
      description: 'username to disable',
    },
  ],
  flags: [],
};
