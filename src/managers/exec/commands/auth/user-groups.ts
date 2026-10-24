import { parseArgs } from '../../../../lib/args/mod.ts';
import { memberNames } from '../../../../lib/auth/member-gids.ts';
import { groupRole } from '../../../../lib/auth/roles.ts';
import { GroupAttrs, isGroupNode } from '../../../../vfs/types/group.ts';
import { UserAttrs } from '../../../../vfs/types/user.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import type { GroupEntry } from '../../../../lib/api/mod.ts';

export const userGroups = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {});
  const username = flags._[0] as string;

  if (!username) {
    await cmd.writeError('user groups: missing username\n');
    return 1;
  }

  const userPath = `${cmd.env.USERS_PATH}/${username}`;

  try {
    const user = await cmd.sys.vfs.get<UserAttrs>(cmd.access, userPath);
    if (!user) {
      await cmd.writeError(`user groups: user '${username}' not found\n`);
      return 1;
    }

    const groups = (await cmd.sys.vfs.children<GroupAttrs>(cmd.access, cmd.env.GROUPS_PATH)).filter((entry) => isGroupNode(entry.node));

    const result: GroupEntry[] = [];

    for (const groupEntry of groups) {
      try {
        const membershipPath = `${cmd.env.GROUPS_PATH}/${groupEntry.name}/users`;
        const isMember = memberNames(membershipPath, await cmd.sys.vfs.children(cmd.access, membershipPath)).includes(username);

        if (isMember) {
          if (cmd.json) {
            const role = groupRole(groupEntry.name, groupEntry.node.attrs.gid);
            result.push({
              groupname: groupEntry.name,
              gid: groupEntry.node.attrs.gid,
              title: groupEntry.node.attrs.title,
              description: groupEntry.node.attrs.description,
              ...(role ? { role } : {}),
            });
          } else {
            await cmd.write(`${groupEntry.name}\t${groupEntry.node.attrs.gid}\t${groupEntry.node.attrs.title || ''}\n`);
          }
        }
      } catch {
        // The group may have no users directory.
      }
    }

    if (cmd.json) {
      await cmd.writeJSON(result);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`user groups: ${message}\n`);
    return 1;
  }
};

userGroups.spec = {
  name: 'user-groups',
  effect: 'read' as const,
  description: 'List groups a user belongs to',
  args: [
    {
      name: 'user',
      type: 'user' as const,
      description: 'user to list groups for',
    },
  ],
  flags: [],
};
