import type { UserInactive } from '../../../../lib/api/users.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { UserAttrs } from '../../../../vfs/types/user.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const userEnable = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {});
  const username = flags._[0] as string;

  if (!username) {
    await cmd.writeError('user enable: missing username\n');
    return 1;
  }

  const userPath = `${cmd.env.USERS_PATH}/${username}`;

  try {
    const user = await cmd.sys.vfs.get<UserAttrs>(cmd.access, userPath);
    if (!user) {
      await cmd.writeError(`user enable: user '${username}' not found\n`);
      return 1;
    }

    if (!user.attrs.inactive) {
      await cmd.writeError(`user enable: user '${username}' is already active\n`);
      return 1;
    }

    await cmd.sys.vfs.update<UserAttrs>(cmd.access, userPath, {
      attrs: { inactive: false },
    });

    if (cmd.json) {
      await cmd.writeJSON({ username, inactive: false } satisfies UserInactive);
    } else {
      await cmd.write(`User '${username}' enabled\n`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`user enable: ${message}\n`);
    return 1;
  }
};

userEnable.spec = {
  name: 'user-enable',
  admin: true,
  effect: 'write' as const,
  description: 'Enable a disabled user account',
  args: [
    {
      name: 'username',
      type: 'user' as const,
      description: 'username to enable',
    },
  ],
  flags: [],
};
