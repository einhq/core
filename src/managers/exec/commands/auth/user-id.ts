import { parseArgs } from '../../../../lib/args/mod.ts';
import { memberNames } from '../../../../lib/auth/member-gids.ts';
import { GroupAttrs, isGroupNode } from '../../../../vfs/types/group.ts';
import { isUserNode, UserAttrs } from '../../../../vfs/types/user.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const userId = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['uid'],
  });

  const targetUid = flags.uid ? Number.parseInt(flags.uid, 10) : cmd.access.uid;

  try {
    const users = (await cmd.sys.vfs.children<UserAttrs>(cmd.access, cmd.env.USERS_PATH)).filter((entry) => isUserNode(entry.node));
    const groups = (await cmd.sys.vfs.children<GroupAttrs>(cmd.access, cmd.env.GROUPS_PATH)).filter((entry) => isGroupNode(entry.node));

    const userEntry = users.find((entry) => entry.node.attrs.uid === targetUid);
    if (!userEntry) {
      await cmd.writeError(`user id: '${targetUid}': no such user\n`);
      return 1;
    }

    const username = userEntry.name;
    const uid = userEntry.node.attrs.uid;
    const gid = userEntry.node.attrs.gid;

    const primaryGroup = groups.find((entry) => entry.node.attrs.gid === gid);
    const primaryGroupName = primaryGroup?.name || String(gid);

    // Every group with a membership link for the user.
    const userGroups: Array<{ gid: number; name: string }> = [];

    for (const groupEntry of groups) {
      try {
        const membershipPath = `${cmd.env.GROUPS_PATH}/${groupEntry.name}/users`;
        const isMember = memberNames(membershipPath, await cmd.sys.vfs.children(cmd.access, membershipPath)).includes(username);

        if (isMember) {
          userGroups.push({
            gid: groupEntry.node.attrs.gid,
            name: groupEntry.name,
          });
        }
      } catch {
        // The group may have no users directory.
      }
    }

    if (cmd.json) {
      await cmd.writeJSON({
        uid,
        user: username,
        gid,
        group: primaryGroupName,
        groups: userGroups.length ? userGroups : [{ gid, name: primaryGroupName }],
      });
      return 0;
    }

    const groupsList = userGroups
      .map((g) => `${g.gid}(${g.name})`)
      .join(',');

    await cmd.write(`uid=${uid}(${username}) gid=${gid}(${primaryGroupName}) groups=${groupsList || `${gid}(${primaryGroupName})`}\n`);

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`user id: ${message}\n`);
    return 1;
  }
};

userId.spec = {
  name: 'user-id',
  effect: 'read' as const,
  description: 'Print user and group IDs',
  args: [],
  flags: [
    {
      name: 'uid',
      type: 'string' as const,
      description: 'show identity for specified uid',
    },
  ],
};
