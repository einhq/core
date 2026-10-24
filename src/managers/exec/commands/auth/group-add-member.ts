import { join } from '@std/path';
import type { MembershipChanged } from '../../../../lib/api/users.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { GroupAttrs } from '../../../../vfs/types/group.ts';
import { NODE_TYPE_SOFTLINK } from '../../../../vfs/types/softlink.ts';
import { UserAttrs } from '../../../../vfs/types/user.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const groupAddMember = async (cmd: Command): CmdReturn => {
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

    const membershipPath = join(groupPath, 'users');

    try {
      await cmd.sys.vfs.create(
        cmd.access,
        NODE_TYPE_SOFTLINK,
        membershipPath,
        username,
        {
          props: {
            uid: cmd.access.uid,
            gid: cmd.access.gid,
            mode: 0o777,
            softlink: userPath,
          },
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes('exists') || message.includes('duplicate key')) {
        throw new Error(`user '${username}' is already a member of group '${groupname}'`);
      }

      throw error;
    }

    if (cmd.json) {
      await cmd.writeJSON({ group: groupname, user: username, action: 'added' } satisfies MembershipChanged);
    } else {
      await cmd.write(`User '${username}' added to group '${groupname}'\n`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`group add-member: ${message}\n`);
    return 1;
  }
};

groupAddMember.spec = {
  name: 'group-add-member',
  admin: true,
  effect: 'write' as const,
  description: 'Add a user to a group',
  args: [
    {
      name: 'group',
      type: 'group' as const,
      description: 'group to add the user to',
    },
    {
      name: 'user',
      type: 'user' as const,
      description: 'user to add to the group',
    },
  ],
  flags: [],
};
