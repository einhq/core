import { parseArgs } from '../../../../lib/args/mod.ts';
import { memberNames } from '../../../../lib/auth/member-gids.ts';
import { GroupAttrs } from '../../../../vfs/types/group.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const groupInfo = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {});
  const groupname = flags._[0] as string;

  if (!groupname) {
    await cmd.writeError('group info: missing group name\n');
    return 1;
  }

  const groupPath = `${cmd.env.GROUPS_PATH}/${groupname}`;

  try {
    const group = await cmd.sys.vfs.get<GroupAttrs>(cmd.access, groupPath);
    if (!group) {
      await cmd.writeError(`group info: group '${groupname}' not found\n`);
      return 1;
    }

    const membershipPath = `${groupPath}/users`;
    let memberCount = 0;
    try {
      memberCount = memberNames(membershipPath, await cmd.sys.vfs.children(cmd.access, membershipPath)).length;
    } catch {
      // The group may have no users directory.
    }

    if (cmd.json) {
      await cmd.writeJSON({
        groupname,
        gid: group.attrs.gid,
        title: group.attrs.title,
        description: group.attrs.description,
        memberCount,
      });
    } else {
      await cmd.write(`Group: ${group.attrs.title || groupname}\n`);
      await cmd.write(`GID: ${group.attrs.gid}\n`);

      if (group.attrs.description) {
        await cmd.write(`Description: ${group.attrs.description}\n`);
      }

      await cmd.write(`Members: ${memberCount}\n`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`group info: group '${groupname}' not found: ${message}\n`);
    return 1;
  }
};

groupInfo.spec = {
  name: 'group-info',
  effect: 'read' as const,
  description: 'Display group information',
  args: [
    {
      name: 'groupname',
      type: 'group' as const,
      description: 'group name to look up',
    },
  ],
  flags: [],
};
