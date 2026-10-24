import { ADMIN_GID, ADMIN_GROUPNAME } from '../../../../lib/access/mod.ts';
import type { GroupDeleted } from '../../../../lib/api/users.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { groupRole } from '../../../../lib/auth/roles.ts';
import { GroupAttrs } from '../../../../vfs/types/group.ts';
import { isUserNode, UserAttrs } from '../../../../vfs/types/user.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const groupDelete = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['force'],
    string: ['to'],
    alias: { f: 'force' },
  });
  const groupname = flags._[0] as string;
  const force = flags.force;

  if (!groupname) {
    await cmd.writeError('group delete: missing group name\n');
    return 1;
  }

  const groupPath = `${cmd.env.GROUPS_PATH}/${groupname}`;

  try {
    const group = await cmd.sys.vfs.get<GroupAttrs>(cmd.access, groupPath);
    if (!group) {
      await cmd.writeError(`group delete: group '${groupname}' does not exist\n`);
      return 1;
    }

    // A built-in group stays: boot makes it, and sign-in and the commands rely on it.
    const groupGid = group.attrs.gid;
    if (groupRole(groupname, groupGid)) {
      await cmd.writeError(`group delete: cannot delete the built-in group '${groupname}'\n`);
      return 1;
    }

    // The heir, by name or gid: `user-delete` names it by the gid it finds on the heir's account.
    // Left out, it is the administrators' gid, which is valid whether or not a group node carries it.
    const groups = await cmd.sys.vfs.children<GroupAttrs>(cmd.access, cmd.env.GROUPS_PATH);
    const to = flags.to === undefined ? String(ADMIN_GID) : String(flags.to);
    const found = /^\d+$/.test(to) ? groups.find((entry) => entry.node.attrs.gid === Number(to)) : groups.find((entry) => entry.name === to);
    const heir = found
      ? { name: found.name, gid: found.node.attrs.gid }
      : to === String(ADMIN_GID) || to === ADMIN_GROUPNAME
      ? { name: ADMIN_GROUPNAME, gid: ADMIN_GID }
      : undefined;
    if (!heir) {
      await cmd.writeError(`group delete: group '${to}' does not exist\n`);
      return 1;
    }
    if (heir.gid === groupGid) {
      await cmd.writeError(`group delete: '${groupname}' cannot take over its own nodes\n`);
      return 1;
    }

    // An account's `gid` attr is its primary group. Handing it to the heir as `releaseOwner` hands
    // over nodes would make each of them a member of a group nobody put them in, so they go back
    // to their own group (gid = uid) instead, and one without such a group keeps the delete from
    // happening.
    const users = await cmd.sys.vfs.children<UserAttrs>(cmd.access, cmd.env.USERS_PATH);
    const usersWithPrimaryGroup = users.filter((user) => isUserNode(user.node) && user.node.attrs.gid === groupGid);

    if (usersWithPrimaryGroup.length > 0) {
      const usernames = usersWithPrimaryGroup.map((u) => u.name).join(', ');
      if (!force) {
        await cmd.writeError(
          `group delete: cannot remove group '${groupname}': it is the primary group of users: ${usernames}\n`,
        );
        return 1;
      }

      const homeless = usersWithPrimaryGroup.filter((user) => {
        const uid = user.node.attrs.uid;
        return uid === groupGid || !groups.some((entry) => entry.node.attrs.gid === uid);
      });
      if (homeless.length > 0) {
        await cmd.writeError(
          `group delete: cannot remove group '${groupname}': no own group to move users to: ${homeless.map((u) => u.name).join(', ')}\n`,
        );
        return 1;
      }

      for (const user of usersWithPrimaryGroup) {
        await cmd.sys.vfs.update<UserAttrs>(cmd.access, `${cmd.env.USERS_PATH}/${user.name}`, { attrs: { gid: user.node.attrs.uid } });
      }
    }

    // Before the group goes: a gid nothing names any more can be handed out again.
    const released = await cmd.sys.vfs.releaseOwner(cmd.access, { kind: 'gid', id: groupGid, to: heir.gid });

    // Recursive: the users directory goes with it.
    await cmd.sys.vfs.unlink(cmd.access, groupPath, cmd.env.GROUPS_PATH, { recursive: true, readlink: true });

    if (cmd.json) {
      await cmd.writeJSON({ deleted: groupname, gid: groupGid, to: heir.name, ...released } satisfies GroupDeleted);
    } else {
      await cmd.write(`Group '${groupname}' deleted; ${released.owned} node(s) now group '${heir.name}', ${released.acl} ACL(s) cleared\n`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`group delete: ${message}\n`);
    return 1;
  }
};

groupDelete.spec = {
  name: 'group-delete',
  admin: true,
  effect: 'write' as const,
  description: 'Delete a group: what it owned goes to another group, and ACL entries naming it are dropped',
  args: [
    {
      name: 'groupname',
      type: 'group' as const,
      description: 'name of the group to delete',
    },
  ],
  flags: [
    { name: 'to', type: 'group' as const, description: `group that takes over the nodes it owned (default ${ADMIN_GROUPNAME})` },
    {
      name: 'force',
      type: 'bool' as const,
      description: 'delete it even if it is a primary group; those users go back to their own group',
    },
  ],
};
