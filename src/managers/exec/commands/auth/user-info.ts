import { parseArgs } from '../../../../lib/args/mod.ts';
import { UserAttrs } from '../../../../vfs/types/user.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const userInfo = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {});
  const username = flags._[0] as string;

  if (!username) {
    await cmd.writeError('user info: missing username\n');
    return 1;
  }

  const userPath = `${cmd.env.USERS_PATH}/${username}`;

  try {
    const user = await cmd.sys.vfs.get<UserAttrs>(cmd.access, userPath);
    if (!user) {
      await cmd.writeError(`user info: user '${username}' not found\n`);
      return 1;
    }

    if (cmd.json) {
      await cmd.writeJSON({
        username,
        uid: user.attrs.uid,
        gid: user.attrs.gid,
        title: user.attrs.name,
        email: user.attrs.email,
        description: user.attrs.description,
        inactive: user.attrs.inactive || false,
        lastLogin: user.attrs.lastLogin,
      });
    } else {
      await cmd.write(`User: ${user.attrs.name || username}\n`);
      await cmd.write(`UID: ${user.attrs.uid}\n`);
      await cmd.write(`GID: ${user.attrs.gid}\n`);

      if (user.attrs.email) {
        await cmd.write(`E-mail: ${user.attrs.email}\n`);
      }

      if (user.attrs.description) {
        await cmd.write(`Description: ${user.attrs.description}\n`);
      }

      if (user.attrs.inactive) {
        await cmd.write(`Status: inactive\n`);
      }

      if (user.attrs.lastLogin) {
        await cmd.write(`Last login: ${user.attrs.lastLogin}\n`);
      }
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`user info: user '${username}' not found: ${message}\n`);
    return 1;
  }
};

userInfo.spec = {
  name: 'user-info',
  effect: 'read' as const,
  description: 'Display user account information',
  args: [
    {
      name: 'username',
      type: 'user' as const,
      description: 'username to look up',
    },
  ],
  flags: [],
};
