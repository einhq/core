import { isLinkUid, LINK_UID_BASE } from '../../../../lib/access/mod.ts';
import { accountNameProblem, type GroupCreated } from '../../../../lib/api/users.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { GroupAttrs, NODE_TYPE_GROUP } from '../../../../vfs/types/group.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const groupCreate = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['gid', 'title', 'description'],
  });
  const name = flags._[0] as string | undefined;
  const title = flags.title;
  const description = flags.description;
  // 0 is a real id (the administrator's), so only a missing flag asks for one to be picked.
  let gid = flags.gid === undefined ? -1 : /^\d+$/.test(flags.gid) ? Number(flags.gid) : Number.NaN;

  if (!name) {
    await cmd.writeError('group create: missing group name\n');
    return 1;
  }

  const problem = accountNameProblem(name);
  if (problem) {
    await cmd.writeError(`group create: ${problem}\n`);
    return 1;
  }

  if (Number.isNaN(gid)) {
    await cmd.writeError(`group create: invalid gid '${flags.gid}'\n`);
    return 1;
  }

  const groups = await cmd.sys.vfs.children<GroupAttrs>(cmd.access, cmd.env.GROUPS_PATH);

  // Without --gid: past every group.
  if (gid === -1) {
    const maxGid = groups.reduce((max, entry) => Math.max(max, entry.node.attrs.gid || 0), 999);
    gid = maxGid + 1;
  }

  // Kept apart from share links' uids, which an ACL entry names beside gids.
  if (isLinkUid(gid)) {
    await cmd.writeError(`group create: gid ${gid} is in the range share links take their uids from (${LINK_UID_BASE} and up)\n`);
    return 1;
  }

  // A gid is the identity the access model uses — `props.gid` and every ACL
  // entry name a gid, never a group node — so two groups sharing one are a
  // single grant answering to two names, and nothing downstream can tell them
  // apart.
  const clash = groups.find((entry) => entry.node.attrs.gid === gid);
  if (clash) {
    await cmd.writeError(`group create: gid ${gid} is already used by '${clash.name}'\n`);
    return 1;
  }

  try {
    await cmd.sys.vfs.create<GroupAttrs>(
      cmd.access,
      NODE_TYPE_GROUP,
      cmd.env.GROUPS_PATH,
      name,
      {
        props: {
          uid: cmd.access.uid,
          gid: gid,
          mode: 0o755,
        },
        attrs: {
          gid,
          title: title || undefined,
          description: description || undefined,
        },
      },
    );

    // The group's users directory holds its membership softlinks. Its members may read it but
    // not change it: a member who could link someone in would hand out the group's access.
    await cmd.sys.vfs.create(
      cmd.access,
      'directory',
      `${cmd.env.GROUPS_PATH}/${name}`,
      'users',
      {
        props: {
          uid: cmd.access.uid,
          gid: gid,
          mode: 0o750,
        },
      },
    );

    const groupPath = `${cmd.env.GROUPS_PATH}/${name}`;

    if (cmd.json) {
      await cmd.writeJSON({ groupname: name, gid, path: groupPath } satisfies GroupCreated);
    } else {
      await cmd.write(`Group '${name}' created\n`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`group create: cannot create group '${name}': ${message}\n`);
    return 1;
  }
};

groupCreate.spec = {
  name: 'group-create',
  admin: true,
  effect: 'write' as const,
  description: 'Create a new group',
  args: [
    {
      name: 'groupname',
      type: 'string' as const,
      description: 'name of the group to create: letters, digits and . _ - @, starting with a letter or _',
    },
  ],
  flags: [
    {
      name: 'gid',
      type: 'string' as const,
      description: 'numeric group ID',
    },
    {
      name: 'title',
      type: 'string' as const,
      description: 'display title for the group',
    },
    {
      name: 'description',
      type: 'string' as const,
      description: 'description of the group',
    },
  ],
};
