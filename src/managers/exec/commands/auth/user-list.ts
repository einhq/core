import { isAdmin } from '../../../../lib/access/mod.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { hasAccountPassword } from '../../../../lib/auth/account-password.ts';
import { userRole } from '../../../../lib/auth/roles.ts';
import { isUserNode, UserAttrs } from '../../../../vfs/types/user.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import type { UserEntry } from '../../../../lib/api/mod.ts';

export const userList = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['inactive', 'active'],
  });
  const showInactive = flags.inactive;
  const showActive = flags.active;

  try {
    const children = await cmd.sys.vfs.children<UserAttrs>(cmd.access, cmd.env.USERS_PATH);
    // Only a user node is an account, whatever else the directory holds.
    const users = children.filter((entry) => isUserNode(entry.node));

    let filteredUsers = users;
    if (showInactive && !showActive) {
      filteredUsers = users.filter((u) => u.node.attrs.inactive);
    } else if (showActive && !showInactive) {
      filteredUsers = users.filter((u) => !u.node.attrs.inactive);
    }

    if (cmd.json) {
      const admin = isAdmin(cmd.access);
      const result = await Promise.all(filteredUsers.map(async (u) => {
        const account = `${cmd.env.USERS_PATH}/${u.name}`;
        const [hasPassword, personPath] = await Promise.all([
          // Whether one is set, never what it is; answered to an administrator only.
          admin ? hasAccountPassword(cmd.sys.vfs, account) : undefined,
          // The link itself, which may point at a person not imported yet.
          cmd.sys.vfs.get(cmd.access, `${account}/person`, { follow: false }).then((link) => link.props.softlink || undefined, () => undefined),
        ]);
        const role = userRole(u.name, u.node.attrs.uid);
        return {
          username: u.name,
          uid: u.node.attrs.uid,
          gid: u.node.attrs.gid,
          title: u.node.attrs.name,
          ...(u.node.attrs.email ? { email: u.node.attrs.email } : {}),
          description: u.node.attrs.description,
          inactive: u.node.attrs.inactive || false,
          mustResetPassword: u.node.attrs.mustResetPassword === true,
          ...(hasPassword !== undefined ? { hasPassword } : {}),
          ...(personPath ? { personPath } : {}),
          ...(role ? { role } : {}),
        } satisfies UserEntry;
      }));
      await cmd.writeJSON(result);
    } else {
      for (const user of filteredUsers) {
        const inactive = user.node.attrs.inactive ? ' (inactive)' : '';
        await cmd.write(`${user.name}\t${user.node.attrs.uid}\t${user.node.attrs.name || ''}${inactive}\n`);
      }
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`user list: ${message}\n`);
    return 1;
  }
};

userList.spec = {
  name: 'user-list',
  effect: 'read' as const,
  description:
    "List the user accounts; as JSON with each one's primary group, e-mail address, description, person and built-in role, and for an administrator whether a password is set",
  args: [],
  flags: [
    { name: 'inactive', type: 'bool' as const, description: 'show only inactive users' },
    { name: 'active', type: 'bool' as const, description: 'show only active users' },
  ],
};
