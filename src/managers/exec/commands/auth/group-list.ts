import { parseArgs } from '../../../../lib/args/mod.ts';
import { memberNames } from '../../../../lib/auth/member-gids.ts';
import { groupRole } from '../../../../lib/auth/roles.ts';
import { GroupAttrs, isGroupNode } from '../../../../vfs/types/group.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import type { GroupEntry } from '../../../../lib/api/mod.ts';

export const groupList = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['members'],
  });

  try {
    const children = await cmd.sys.vfs.children<GroupAttrs>(cmd.access, cmd.env.GROUPS_PATH);
    // `/etc/groups` may hold other nodes beside the groups; only a group node is one.
    const groups = children.filter((entry) => isGroupNode(entry.node));

    // Each group's membership links, listed as the caller: a `users` directory the caller may not
    // list leaves that group's members out.
    const membersPaths = groups.map((g) => `${cmd.env.GROUPS_PATH}/${g.name}/users`);
    const listings = flags.members ? await cmd.sys.vfs.childrenMany(cmd.access, membersPaths) : [];
    const membersAt = (index: number): string[] | undefined => {
      const listing = listings[index];
      return listing?.status === 'fulfilled' ? memberNames(membersPaths[index], listing.value).sort() : undefined;
    };

    if (cmd.json) {
      const result = groups.map((g, index) => {
        const role = groupRole(g.name, g.node.attrs.gid);
        const members = membersAt(index);
        return {
          groupname: g.name,
          gid: g.node.attrs.gid,
          title: g.node.attrs.title,
          description: g.node.attrs.description,
          ...(role ? { role } : {}),
          ...(members ? { members } : {}),
        } satisfies GroupEntry;
      });
      await cmd.writeJSON(result);
    } else {
      for (const [index, group] of groups.entries()) {
        const members = flags.members ? `\t${membersAt(index)?.join(',') ?? ''}` : '';
        await cmd.write(`${group.name}\t${group.node.attrs.gid}\t${group.node.attrs.title || ''}${members}\n`);
      }
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`group list: ${message}\n`);
    return 1;
  }
};

groupList.spec = {
  name: 'group-list',
  effect: 'read' as const,
  description: "List the groups; as JSON with each one's description and built-in role",
  args: [],
  flags: [
    {
      name: 'members',
      type: 'bool' as const,
      description: "also list the usernames linked into each group, where the caller may see them (a primary group's users are not linked)",
    },
  ],
};
