import { dirname, join } from '@std/path';
import { ADMIN_GID, ADMIN_UID, ADMIN_USERNAME } from '../../../../lib/access/mod.ts';
import type { UserDeleted } from '../../../../lib/api/users.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { memberNames } from '../../../../lib/auth/member-gids.ts';
import { userRole } from '../../../../lib/auth/roles.ts';
import { shq } from '../../../../lib/shell-quote/mod.ts';
import { GroupAttrs } from '../../../../vfs/types/group.ts';
import { UserAttrs } from '../../../../vfs/types/user.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { endSessionsOf } from './sessions.ts';

export const userDelete = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['force'],
    string: ['to'],
    alias: { f: 'force' },
  });
  const username = flags._[0] as string;
  const force = flags.force;

  if (!username) {
    await cmd.writeError('user delete: missing username\n');
    return 1;
  }

  const userPath = `${cmd.env.USERS_PATH}/${username}`;

  try {
    const user = await cmd.sys.vfs.get<UserAttrs>(cmd.access, userPath);
    if (!user) {
      await cmd.writeError(`user delete: user '${username}' does not exist\n`);
      return 1;
    }

    // The system's own shells and services run as the administrator, and a visitor who has not
    // signed in browses as the guest.
    const role = userRole(username, user.attrs.uid);
    if (role === 'administrator') {
      await cmd.writeError(`user delete: cannot delete the administrator\n`);
      return 1;
    }
    if (role === 'guest') {
      await cmd.writeError(`user delete: cannot delete the guest account\n`);
      return 1;
    }

    const userUid = user.attrs.uid;

    // Left out, the heir is the administrator, which is valid whether or not a user node carries that uid.
    const heirName = flags.to === undefined ? ADMIN_USERNAME : String(flags.to);
    const heirNode = await cmd.sys.vfs.get<UserAttrs>(cmd.access, `${cmd.env.USERS_PATH}/${heirName}`).catch(() => undefined);
    const heir = heirNode ? { uid: heirNode.attrs.uid, gid: heirNode.attrs.gid } : heirName === ADMIN_USERNAME ? { uid: ADMIN_UID, gid: ADMIN_GID } : undefined;
    if (!heir) {
      await cmd.writeError(`user delete: user '${heirName}' does not exist\n`);
      return 1;
    }
    if (heir.uid === userUid) {
      await cmd.writeError(`user delete: '${username}' cannot take over its own nodes\n`);
      return 1;
    }

    // Before the account goes: a uid nothing names any more can be handed out again, and a
    // failed delete is then retried with the nodes already handed over.
    const released = await cmd.sys.vfs.releaseOwner(cmd.access, { kind: 'uid', id: userUid, to: heir.uid });

    // Out of every group first.
    const groups = await cmd.sys.vfs.children<GroupAttrs>(cmd.access, cmd.env.GROUPS_PATH);

    for (const groupEntry of groups) {
      const membershipPath = `${cmd.env.GROUPS_PATH}/${groupEntry.name}/users/${username}`;
      try {
        await cmd.sys.vfs.unlink(cmd.access, membershipPath, dirname(membershipPath), { readlink: true });
      } catch {
        // Not a member of this group.
      }
    }

    // The home with everything in it, then the account with its password and person link.
    for (const path of [join(cmd.env.HOMES_PATH, username), userPath]) {
      try {
        if (!(await cmd.sys.vfs.exists(cmd.access, path, { follow: false }))) continue;
        await cmd.sys.vfs.unlink(cmd.access, path, dirname(path), { recursive: true, readlink: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!force) {
          await cmd.writeError(`user delete: cannot delete '${path}': ${message}\n`);
          return 1;
        }
      }
    }

    await endSessionsOf(cmd, userUid);

    const group = await deleteOwnGroup(cmd, username, userUid, heir.gid);

    if (cmd.json) {
      await cmd.writeJSON({ deleted: username, uid: userUid, to: heirName, ...released, ...(group ? { group } : {}) } satisfies UserDeleted);
    } else {
      await cmd.write(`User '${username}' deleted; ${released.owned} node(s) now owned by '${heirName}', ${released.acl} ACL(s) cleared\n`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`user delete: ${message}\n`);
    return 1;
  }
};

/**
 * The user's own group — their name, their uid as gid — goes with them, its nodes to the heir's
 * primary group. It stays, with a warning, while someone else still belongs to it or has it as
 * their primary group. Undefined when there is no such group.
 */
const deleteOwnGroup = async (
  cmd: Command,
  username: string,
  uid: number,
  heirGid: number,
): Promise<UserDeleted['group']> => {
  const groupPath = `${cmd.env.GROUPS_PATH}/${username}`;
  const group = await cmd.sys.vfs.get<GroupAttrs>(cmd.access, groupPath).catch(() => undefined);
  if (!group || group.attrs.gid !== uid) return undefined;

  const members = memberNames(`${groupPath}/users`, await cmd.sys.vfs.children(cmd.access, `${groupPath}/users`));
  const users = await cmd.sys.vfs.children<UserAttrs>(cmd.access, cmd.env.USERS_PATH);
  const others = [
    ...new Set([...members, ...users.filter((user) => user.node.attrs.gid === uid).map((user) => user.name)]),
  ];
  if (others.length > 0) {
    await cmd.writeError(`user delete: warning: keeping group '${username}', still the group of: ${others.join(', ')}\n`);
    return { groupname: username, deleted: false };
  }

  const result = await cmd.execute(`group-delete ${shq(username)} --to ${heirGid}`);
  if (result.code !== 0) {
    await cmd.writeError(`user delete: warning: failed to delete group '${username}': ${result.stderr}\n`);
    return { groupname: username, deleted: false };
  }
  return { groupname: username, deleted: true };
};

userDelete.spec = {
  name: 'user-delete',
  admin: true,
  effect: 'write' as const,
  description: 'Delete a user account, its home, its own group, and its open sessions; what it owned goes to another user',
  args: [
    {
      name: 'username',
      type: 'user' as const,
      description: 'username to delete',
    },
  ],
  flags: [
    { name: 'to', type: 'user' as const, description: `user that takes over the nodes it owned (default ${ADMIN_USERNAME})` },
    { name: 'force', type: 'bool' as const, description: 'force deletion even if errors occur' },
  ],
};
