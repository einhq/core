import { join } from '@std/path';
import { ADMIN_ACCESS, isAdmin } from '../../../../lib/access/mod.ts';
import type { UserUpdated } from '../../../../lib/api/users.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { emailHolder, parseEmailFlag } from '../../../../lib/auth/email.ts';
import { USERS_PATH } from '../../../../lib/paths.ts';
import { isUserNode, UserAttrs } from '../../../../vfs/types/user.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const userUpdate = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['name', 'email', 'description'],
  });
  const username = flags._[0] as string;
  const name = flags.name;
  const description = flags.description;

  if (!username) {
    await cmd.writeError('user update: missing username\n');
    return 1;
  }

  if (name === undefined && flags.email === undefined && description === undefined) {
    await cmd.writeError('user update: at least one of --name, --email or --description must be provided\n');
    return 1;
  }

  const parsed = flags.email === undefined ? undefined : parseEmailFlag(flags.email);
  if (parsed && 'problem' in parsed) {
    await cmd.writeError(`user update: ${parsed.problem}\n`);
    return 1;
  }
  const email = parsed?.email;

  // An account is the administrator's node, but its name and description are its own user's to
  // say: for them alone the account is read from the fixed layout and written as the administrator.
  const admin = isAdmin(cmd.access);
  if (!admin && email !== undefined) {
    await cmd.writeError("user update: an account's e-mail address is the administrator's to set\n");
    return 1;
  }
  const userPath = admin ? `${cmd.env.USERS_PATH}/${username}` : join(USERS_PATH, username);

  try {
    const user = await cmd.sys.vfs.get<UserAttrs>(cmd.access, userPath).catch(() => undefined);
    if (!user || !isUserNode(user)) {
      await cmd.writeError(`user update: user '${username}' not found\n`);
      return 1;
    }
    if (!admin && user.attrs.uid !== cmd.access.uid) {
      await cmd.writeError('user update: permission denied\n');
      return 1;
    }

    if (email) {
      const holder = await emailHolder(cmd.sys.vfs, cmd.env.USERS_PATH, email, username);
      if (holder) {
        await cmd.writeError(`user update: '${email}' is already the e-mail address of '${holder}'\n`);
        return 1;
      }
    }

    await cmd.sys.vfs.update<UserAttrs>(
      admin ? cmd.access : ADMIN_ACCESS,
      userPath,
      {
        attrs: {
          ...(name !== undefined ? { name } : {}),
          // An empty address removes it.
          ...(email !== undefined ? { email: email || null } : {}),
          ...(description !== undefined ? { description } : {}),
        },
      },
    );

    if (cmd.json) {
      await cmd.writeJSON(
        {
          username,
          updated: {
            ...(name !== undefined ? { name } : {}),
            ...(email !== undefined ? { email } : {}),
            ...(description !== undefined ? { description } : {}),
          },
        } satisfies UserUpdated,
      );
    } else {
      await cmd.write(`User '${username}' updated\n`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`user update: ${message}\n`);
    return 1;
  }
};

userUpdate.spec = {
  name: 'user-update',
  effect: 'write' as const,
  description: "Update an account's display name, description and (an administrator only) e-mail address; anyone may update their own name and description",
  args: [
    {
      name: 'username',
      type: 'user' as const,
      description: 'username to update',
    },
  ],
  flags: [
    {
      name: 'name',
      type: 'string' as const,
      description: 'set display name',
    },
    {
      name: 'email',
      type: 'string' as const,
      description: 'set the e-mail address, which signs in like the username; empty to remove it',
    },
    {
      name: 'description',
      type: 'string' as const,
      description: 'set description',
    },
  ],
};
