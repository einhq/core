import { parseArgs } from '../../../../lib/args/mod.ts';
import { memberNames } from '../../../../lib/auth/member-gids.ts';
import { GroupAttrs } from '../../../../vfs/types/group.ts';
import { UserAttrs } from '../../../../vfs/types/user.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import type { GroupMember, GroupMemberPage } from '../../../../lib/api/mod.ts';

export const groupMembers = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { string: ['limit'] });
  const groupname = flags._[0] as string;

  if (!groupname) {
    await cmd.writeError('group members: missing group name\n');
    return 1;
  }

  const limit = flags.limit === undefined ? undefined : Number(flags.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) {
    await cmd.writeError(`group members: --limit must be between 1 and 50, got '${flags.limit}'\n`);
    return 1;
  }

  const groupPath = `${cmd.env.GROUPS_PATH}/${groupname}`;

  try {
    const group = await cmd.sys.vfs.get<GroupAttrs>(cmd.access, groupPath);
    if (!group) {
      await cmd.writeError(`group members: group '${groupname}' not found\n`);
      return 1;
    }

    const membershipPath = `${groupPath}/users`;
    const members = memberNames(membershipPath, await cmd.sys.vfs.children(cmd.access, membershipPath));
    const shown = limit === undefined ? members : members.slice(0, limit);

    if (cmd.json) {
      const result: GroupMember[] = [];
      for (const member of shown) {
        const userPath = `${cmd.env.USERS_PATH}/${member}`;
        try {
          const user = await cmd.sys.vfs.get<UserAttrs>(cmd.access, userPath);
          if (user) {
            // The link itself, which may point at a person not imported yet.
            const personPath = await cmd.sys.vfs.get(cmd.access, `${userPath}/person`, { follow: false })
              .then((link) => link.props.softlink || undefined, () => undefined);
            result.push({
              username: member,
              uid: user.attrs.uid,
              title: user.attrs.name,
              ...(personPath ? { personPath } : {}),
            });
          }
        } catch {
          // A membership link to a user that is gone.
          result.push({ username: member });
        }
      }
      await cmd.writeJSON(limit === undefined ? result : { members: result, total: members.length } satisfies GroupMemberPage);
    } else {
      for (const member of shown) {
        const userPath = `${cmd.env.USERS_PATH}/${member}`;
        try {
          const user = await cmd.sys.vfs.get<UserAttrs>(cmd.access, userPath);
          if (user) {
            await cmd.write(`${member}\t${user.attrs.uid}\t${user.attrs.name || ''}\n`);
          } else {
            await cmd.write(`${member}\n`);
          }
        } catch {
          await cmd.write(`${member}\n`);
        }
      }
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`group members: ${message}\n`);
    return 1;
  }
};

groupMembers.spec = {
  name: 'group-members',
  admin: true,
  effect: 'read' as const,
  description: 'List members of a group',
  args: [
    {
      name: 'group',
      type: 'group' as const,
      description: 'group to list members of',
    },
  ],
  flags: [
    { name: 'limit', type: 'string' as const, description: 'maximum members to return (1-50)' },
  ],
};
