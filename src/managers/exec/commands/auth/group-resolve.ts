import type { GroupResolved } from '../../../../lib/api/users.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { GroupAttrs, isGroupNode } from '../../../../vfs/types/group.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const groupResolve = async (cmd: Command): CmdReturn => {
  // Arguments as typed, so `0` is an id rather than no argument; an id is told from a name below.
  const flags = parseArgs(cmd.args, { string: ['_'] });
  const input = flags._[0] as string | undefined;

  if (!input) {
    await cmd.writeError('group resolve: missing gid or group name\n');
    return 1;
  }

  try {
    const groups = (await cmd.sys.vfs.children<GroupAttrs>(cmd.access, cmd.env.GROUPS_PATH)).filter((entry) => isGroupNode(entry.node));

    const asNumber = Number.parseInt(input, 10);
    const isNumeric = !Number.isNaN(asNumber) && String(asNumber) === input;

    if (isNumeric) {
      const group = groups.find((g) => g.node.attrs.gid === asNumber);
      if (!group) {
        await cmd.writeError(`group resolve: gid ${input} not found\n`);
        return 1;
      }

      if (cmd.json) {
        await cmd.writeJSON(
          {
            gid: asNumber,
            groupname: group.name,
            title: group.node.attrs.title,
          } satisfies GroupResolved,
        );
      } else {
        await cmd.write(`${group.name}\n`);
      }
    } else {
      const group = groups.find((g) => g.name === input);
      if (!group) {
        await cmd.writeError(`group resolve: group '${input}' not found\n`);
        return 1;
      }

      if (cmd.json) {
        await cmd.writeJSON(
          {
            groupname: input,
            gid: group.node.attrs.gid,
            title: group.node.attrs.title,
          } satisfies GroupResolved,
        );
      } else {
        await cmd.write(`${group.node.attrs.gid}\n`);
      }
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`group resolve: ${message}\n`);
    return 1;
  }
};

groupResolve.spec = {
  name: 'group-resolve',
  effect: 'read' as const,
  description: 'Resolve group name to GID or vice versa',
  args: [
    {
      name: 'gid_or_groupname',
      type: 'string' as const,
      description: 'gid (numeric) or group name to resolve',
    },
  ],
  flags: [],
};
