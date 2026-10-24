import type { MembershipChanged } from '../../../../lib/api/users.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { GroupAttrs } from '../../../../vfs/types/group.ts';
import { UserAttrs } from '../../../../vfs/types/user.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const groupRemoveMember = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {});
  const groupname = flags._[0] as string;
  const username = flags._[1] as string;

  if (!groupname) {
    await cmd.writeError('group remove-member: missing group name\n');
    return 1;
  }

  if (!username) {
    await cmd.writeError('group remove-member: missing username\n');
    return 1;
  }

  const groupPath = `${cmd.env.GROUPS_PATH}/${groupname}`;
  const userPath = `${cmd.env.USERS_PATH}/${username}`;

  try {
    const group = await cmd.sys.vfs.get<GroupAttrs>(cmd.access, groupPath);
    if (!group) {
      await cmd.writeError(`group remove-member: group '${groupname}' not found\n`);
      return 1;
    }

    const user = await cmd.sys.vfs.get<UserAttrs>(cmd.access, userPath);
    if (!user) {
      await cmd.writeError(`group remove-member: user '${username}' not found\n`);
      return 1;
    }

    const membershipLinkPath = `${groupPath}/users/${username}`;

    try {
      await cmd.sys.vfs.unlink(cmd.access, membershipLinkPath, `${groupPath}/users`, { readlink: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('not found')) {
        await cmd.writeError(`group remove-member: user '${username}' is not a member of group '${groupname}'\n`);
        return 1;
      }
      throw error;
    }

    if (cmd.json) {
      await cmd.writeJSON({ group: groupname, user: username, action: 'removed' } satisfies MembershipChanged);
    } else {
      await cmd.write(`User '${username}' removed from group '${groupname}'\n`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`group remove-member: ${message}\n`);
    return 1;
  }
};

groupRemoveMember.spec = {
  name: 'group-remove-member',
  admin: true,
  effect: 'write' as const,
  description: 'Remove a user from a group',
  args: [
    {
      name: 'group',
      type: 'group' as const,
      description: 'group to remove the user from',
    },
    {
      name: 'user',
      type: 'user' as const,
      description: 'user to remove from the group',
    },
  ],
  flags: [],
};
