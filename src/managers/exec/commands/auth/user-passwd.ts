import { parseArgs } from '../../../../lib/args/mod.ts';
import { isAdmin } from '../../../../lib/access/mod.ts';
import { hasAccountPassword, isAccountPassword, setAccountPassword } from '../../../../lib/auth/account-password.ts';
import { userRole } from '../../../../lib/auth/roles.ts';
import { isUserNode, UserAttrs } from '../../../../vfs/types/user.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const userPasswd = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['username', 'old-password', 'new-password'],
    alias: { u: 'username', o: 'old-password', n: 'new-password' },
  });

  const username = flags.username || flags._[0] as string;

  if (!username) {
    await cmd.writeError('user passwd: missing username\n');
    return 1;
  }

  const oldPassword = flags['old-password'];
  const newPassword = flags['new-password'] ?? await cmd.prompt('Password: ', 'secret', 'add --new-password');

  if (!newPassword) {
    await cmd.writeError('user passwd: new password is required (--new-password)\n');
    return 1;
  }

  const userPath = `${cmd.env.USERS_PATH}/${username}`;

  try {
    const user = await cmd.sys.vfs.get<UserAttrs>(cmd.access, userPath);
    if (!user || !isUserNode(user)) {
      await cmd.writeError(`user passwd: user '${username}' does not exist\n`);
      return 1;
    }

    // Whoever reaches the server without signing in is the guest; a password would let someone
    // sign in as it and get what every signed-in person may see.
    if (userRole(username, user.attrs.uid) === 'guest') {
      await cmd.writeError('user passwd: the guest account cannot have a password\n');
      return 1;
    }

    // Only the user themselves or an admin.
    if (cmd.access.uid !== user.attrs.uid && !isAdmin(cmd.access)) {
      await cmd.writeError('user passwd: permission denied\n');
      return 1;
    }

    // Anyone but an admin proves the current password.
    if (!isAdmin(cmd.access)) {
      if (!oldPassword) {
        await cmd.writeError('user passwd: current password must be provided (--old-password)\n');
        return 1;
      }

      if (!await hasAccountPassword(cmd.sys.vfs, userPath)) {
        await cmd.writeError('user passwd: no existing password found, contact admin\n');
        return 1;
      }
      if (!await isAccountPassword(cmd.sys.vfs, userPath, oldPassword)) {
        await cmd.writeError('user passwd: authentication failed\n');
        return 1;
      }
    }

    await setAccountPassword(cmd.sys.vfs, { ...cmd.access, admin: true }, userPath, newPassword, cmd.launchEnv);

    // Setting a password clears the reset gate (imported users start gated).
    if (user.attrs.mustResetPassword) {
      await cmd.sys.vfs.update<UserAttrs>({ ...cmd.access, admin: true }, userPath, { attrs: { mustResetPassword: false } });
    }

    if (cmd.json) {
      await cmd.writeJSON({ ok: true });
    } else {
      await cmd.write('Password updated successfully\n');
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`user passwd: ${message}\n`);
    return 1;
  }
};

userPasswd.spec = {
  name: 'user-passwd',
  effect: 'write' as const,
  description: 'Change user password',
  args: [
    {
      name: 'username',
      type: 'user' as const,
      description: 'username to change password for',
    },
  ],
  flags: [
    {
      name: 'username',
      type: 'user' as const,
      description: 'username (alternative to positional)',
    },
    {
      name: 'old-password',
      type: 'string' as const,
      description: 'current password (required for non-admin)',
    },
    {
      name: 'new-password',
      type: 'string' as const,
      description: 'new password to set',
    },
  ],
};
