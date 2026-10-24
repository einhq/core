import { parseArgs } from '../../../../lib/args/mod.ts';
import { GroupAttrs } from '../../../../vfs/types/group.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const groupExists = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {});
  const groupname = flags._[0] as string;

  if (!groupname) {
    await cmd.writeError('group exists: missing group name\n');
    return 1;
  }

  const groupPath = `${cmd.env.GROUPS_PATH}/${groupname}`;

  try {
    const group = await cmd.sys.vfs.get<GroupAttrs>(cmd.access, groupPath);
    const exists = group !== null;

    if (cmd.json) {
      await cmd.writeJSON({ groupname, exists });
    }

    return exists ? 0 : 1;
  } catch {
    if (cmd.json) {
      await cmd.writeJSON({ groupname, exists: false });
    }
    return 1;
  }
};

groupExists.spec = {
  name: 'group-exists',
  effect: 'read' as const,
  description: 'Check if a group exists',
  args: [
    {
      name: 'groupname',
      type: 'string' as const,
      description: 'group name to check',
    },
  ],
  flags: [],
};
