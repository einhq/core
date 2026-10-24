import type { GroupUpdated } from '../../../../lib/api/users.ts';
import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '../../../../lib/args/mod.ts';
import { GroupAttrs } from '../../../../vfs/types/group.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const groupUpdate = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, {
    string: ['title', 'description'],
    unknown: collectUnknownFlags(unknown),
  });
  const groupname = flags._[0] as string;
  const title = flags.title;
  const description = flags.description;

  if (unknown.some((flag) => /^--gid(=|$)/.test(flag))) {
    await cmd.writeError("group update: a group's gid is set when it is created and cannot be changed\n");
    return 1;
  }
  if (await reportUnknownFlags(cmd, unknown)) return 1;

  if (!groupname) {
    await cmd.writeError('group update: missing group name\n');
    return 1;
  }

  const groupPath = `${cmd.env.GROUPS_PATH}/${groupname}`;

  try {
    const group = await cmd.sys.vfs.get<GroupAttrs>(cmd.access, groupPath);
    if (!group) {
      await cmd.writeError(`group update: group '${groupname}' does not exist\n`);
      return 1;
    }

    const updated: GroupUpdated['updated'] = {
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
    };

    if (Object.keys(updated).length === 0) {
      await cmd.writeError('group update: no changes specified\n');
      return 1;
    }

    await cmd.sys.vfs.update<GroupAttrs>(cmd.access, groupPath, { attrs: updated });

    if (cmd.json) {
      await cmd.writeJSON({ groupname, updated } satisfies GroupUpdated);
    } else {
      await cmd.write(`Group '${groupname}' updated\n`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`group update: ${message}\n`);
    return 1;
  }
};

groupUpdate.spec = {
  name: 'group-update',
  admin: true,
  effect: 'write' as const,
  description: "Update a group's title or description; its gid is fixed when it is created",
  args: [
    {
      name: 'groupname',
      type: 'group' as const,
      description: 'name of the group to update',
    },
  ],
  flags: [
    {
      name: 'title',
      type: 'string' as const,
      description: 'set display title',
    },
    {
      name: 'description',
      type: 'string' as const,
      description: 'set description',
    },
  ],
};
