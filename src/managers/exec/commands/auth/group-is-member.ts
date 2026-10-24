import { join } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { isMembership } from '../../../../lib/auth/member-gids.ts';
import { NodeNotFoundError } from '../../../../vfs/mod.ts';
import { GroupAttrs } from '../../../../vfs/types/group.ts';
import { UserAttrs } from '../../../../vfs/types/user.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const groupIsMember = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {});
  const groupname = flags._[0] as string;
  const username = flags._[1] as string;

  try {
    if (!groupname) {
      throw new Error('missing group name');
    }

    if (!username) {
      throw new Error('missing username');
    }

    const groupPath = join(cmd.env.GROUPS_PATH, groupname);
    const userPath = join(cmd.env.USERS_PATH, username);

    const group = await cmd.sys.vfs.get<GroupAttrs>(cmd.access, groupPath);
    if (!group) {
      throw new Error(`group '${groupname}' not found`);
    }

    const user = await cmd.sys.vfs.get<UserAttrs>(cmd.access, userPath);
    if (!user) {
      throw new Error(`user '${username}' not found`);
    }

    const membershipPath = join(groupPath, 'users', username);

    try {
      const node = await cmd.sys.vfs.get(cmd.access, membershipPath, { readlink: true });

      if (!isMembership(join(groupPath, 'users'), username, node)) {
        throw new Error(`'${membershipPath}' is not a correct softlink to '${userPath}'`);
      }
    } catch (err) {
      if (err instanceof NodeNotFoundError) {
        return 1;
      }

      throw err;
    }

    if (cmd.json) {
      await cmd.writeJSON({});
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`group is-member: ${message}\n`);
    return 1;
  }
};

groupIsMember.spec = {
  name: 'group-is-member',
  effect: 'read' as const,
  description: 'Check if a user is a member of a group',
  args: [
    {
      name: 'group',
      type: 'group' as const,
      description: 'group to check if the user is member of',
    },
    {
      name: 'user',
      type: 'user' as const,
      description: 'user to check',
    },
  ],
  flags: [],
};
