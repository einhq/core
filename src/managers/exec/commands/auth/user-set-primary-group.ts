import type { PrimaryGroupSet } from '../../../../lib/api/users.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { GroupAttrs } from '../../../../vfs/types/group.ts';
import { UserAttrs } from '../../../../vfs/types/user.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const userSetPrimaryGroup = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {});
  const username = flags._[0] as string;
  const groupname = flags._[1] as string;

  if (!username) {
    await cmd.writeError('user set-primary-group: missing username\n');
    return 1;
  }

  if (!groupname) {
    await cmd.writeError('user set-primary-group: missing group name\n');
    return 1;
  }

  const userPath = `${cmd.env.USERS_PATH}/${username}`;
  const groupPath = `${cmd.env.GROUPS_PATH}/${groupname}`;

  try {
    const user = await cmd.sys.vfs.get<UserAttrs>(cmd.access, userPath);
    if (!user) {
      await cmd.writeError(`user set-primary-group: user '${username}' not found\n`);
      return 1;
    }

    const group = await cmd.sys.vfs.get<GroupAttrs>(cmd.access, groupPath);
    if (!group) {
      await cmd.writeError(`user set-primary-group: group '${groupname}' not found\n`);
      return 1;
    }

    const newGid = group.attrs.gid;
    const oldGid = user.attrs.gid;

    if (oldGid === newGid) {
      await cmd.writeError(`user set-primary-group: '${groupname}' is already the primary group for '${username}'\n`);
      return 1;
    }

    await cmd.sys.vfs.update<UserAttrs>(cmd.access, userPath, {
      attrs: { gid: newGid },
    });

    if (cmd.json) {
      await cmd.writeJSON(
        {
          username,
          oldGid,
          newGid,
          primaryGroup: groupname,
        } satisfies PrimaryGroupSet,
      );
    } else {
      await cmd.write(`Primary group for '${username}' set to '${groupname}' (gid: ${newGid})\n`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`user set-primary-group: ${message}\n`);
    return 1;
  }
};

userSetPrimaryGroup.spec = {
  name: 'user-set-primary-group',
  admin: true,
  effect: 'write' as const,
  description: "Set a user's primary group",
  args: [
    {
      name: 'user',
      type: 'user' as const,
      description: 'user to change primary group for',
    },
    {
      name: 'group',
      type: 'group' as const,
      description: 'new primary group',
    },
  ],
  flags: [],
};
