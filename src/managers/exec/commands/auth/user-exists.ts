import { parseArgs } from '../../../../lib/args/mod.ts';
import { UserAttrs } from '../../../../vfs/types/user.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const userExists = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {});
  const username = flags._[0] as string;

  if (!username) {
    await cmd.writeError('user exists: missing username\n');
    return 1;
  }

  const userPath = `${cmd.env.USERS_PATH}/${username}`;

  try {
    const user = await cmd.sys.vfs.get<UserAttrs>(cmd.access, userPath);
    const exists = user !== null;

    if (cmd.json) {
      await cmd.writeJSON({ username, exists });
    }

    return exists ? 0 : 1;
  } catch {
    if (cmd.json) {
      await cmd.writeJSON({ username, exists: false });
    }
    return 1;
  }
};

userExists.spec = {
  name: 'user-exists',
  effect: 'read' as const,
  description: 'Check if a user account exists',
  args: [
    {
      name: 'username',
      type: 'string' as const,
      description: 'username to check',
    },
  ],
  flags: [],
};
