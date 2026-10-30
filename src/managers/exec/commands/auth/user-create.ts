import { ADMIN_ACCESS, ADMIN_GID, ADMIN_UID, GUEST_UID, isLinkUid, LINK_UID_BASE, USERS_GID } from '../../../../lib/access/mod.ts';
import { accountNameProblem, type UserCreated } from '../../../../lib/api/users.ts';
import { emailHolder, parseEmailFlag } from '../../../../lib/auth/email.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { groupRole } from '../../../../lib/auth/roles.ts';
import { defaultUserGroups } from '../../../../lib/config/read-settings.ts';
import { HOME_MODE } from '../../../../lib/paths.ts';
import { shq } from '../../../../lib/shell-quote/mod.ts';
import { join } from '@std/path';
import { GroupAttrs, isGroupNode } from '../../../../vfs/types/group.ts';
import { NODE_TYPE_DIRECTORY } from '../../../../vfs/types/directory.ts';
import { isUserNode, NODE_TYPE_USER, UserAttrs } from '../../../../vfs/types/user.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const userCreate = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['uid', 'title', 'email', 'description', 'groups'],
  });
  const name = flags._[0] as string | undefined;
  const title = flags.title;
  const description = flags.description;
  // 0 is a real id (the administrator's), so only a missing flag asks for one to be picked.
  let uid = flags.uid === undefined ? -1 : /^\d+$/.test(flags.uid) ? Number(flags.uid) : Number.NaN;

  if (!name) {
    await cmd.writeError('user create: missing username\n');
    return 1;
  }

  const problem = accountNameProblem(name);
  if (problem) {
    await cmd.writeError(`user create: ${problem}\n`);
    return 1;
  }

  const email = flags.email === undefined ? undefined : parseEmailFlag(flags.email);
  if (email && 'problem' in email) {
    await cmd.writeError(`user create: ${email.problem}\n`);
    return 1;
  }

  if (Number.isNaN(uid)) {
    await cmd.writeError(`user create: invalid uid '${flags.uid}'\n`);
    return 1;
  }

  // Any node takes the name; only user and group nodes hold a uid or gid.
  const userChildren = await cmd.sys.vfs.children<UserAttrs>(cmd.access, cmd.env.USERS_PATH);
  if (userChildren.some((entry) => entry.name === name)) {
    await cmd.writeError(`user create: user '${name}' already exists\n`);
    return 1;
  }
  const users = userChildren.filter((entry) => isUserNode(entry.node));
  const home = join(cmd.env.HOMES_PATH, name);
  if (await cmd.sys.vfs.exists(ADMIN_ACCESS, home, { follow: false })) {
    await cmd.writeError(`user create: '${home}' already exists\n`);
    return 1;
  }

  if (email?.email) {
    const holder = await emailHolder(cmd.sys.vfs, cmd.env.USERS_PATH, email.email);
    if (holder) {
      await cmd.writeError(`user create: '${email.email}' is already the e-mail address of '${holder}'\n`);
      return 1;
    }
  }

  const groupChildren = await cmd.sys.vfs.children<GroupAttrs>(cmd.access, cmd.env.GROUPS_PATH);
  if (groupChildren.some((entry) => entry.name === name && !isGroupNode(entry.node))) {
    await cmd.writeError(`user create: '${cmd.env.GROUPS_PATH}/${name}' exists and is not a group\n`);
    return 1;
  }
  const groups = groupChildren.filter((entry) => isGroupNode(entry.node));

  // The new user's own group takes the uid as its gid, and a session counts its primary gid as a
  // membership — so a uid whose number another group already holds would quietly make the new
  // user a member of that group.
  const gidHolder = (gid: number) => groups.find((entry) => entry.node.attrs.gid === gid && entry.name !== name);

  // A group already named like the user becomes its own group, so the uid is that group's gid.
  // Boot makes `admin` and `guest` this way. `users`, `ssh` and `sudo` are never one account's
  // own, whether or not the group exists yet: its primary group would be that group, and `sudo`'s
  // would let it elevate.
  const ownGroup = groups.find((entry) => entry.name === name);
  const role = groupRole(name, ownGroup?.node.attrs.gid);
  if (role === 'everyone' || role === 'ssh' || role === 'sudo') {
    await cmd.writeError(`user create: '${name}' is the name of a built-in group\n`);
    return 1;
  }
  if (ownGroup) {
    const gid = ownGroup.node.attrs.gid;
    if (uid !== -1 && uid !== gid) {
      await cmd.writeError(`user create: a group '${name}' exists with gid ${gid}; the user's uid must match it\n`);
      return 1;
    }
    const uidHolder = users.find((entry) => entry.node.attrs.uid === gid);
    if (uidHolder) {
      await cmd.writeError(`user create: a group '${name}' exists with gid ${gid}, which is already the uid of '${uidHolder.name}'\n`);
      return 1;
    }
    uid = gid;
  }

  // Without --uid: past every user, on a number no other group holds. The guest's uid and
  // `USERS_GID` are skipped even where nothing holds them yet: the access model treats the one as
  // the guest and the other as every signed-in person's group.
  if (uid === -1) {
    uid = users.reduce((max, entry) => Math.max(max, entry.node.attrs.uid || 0), 999) + 1;
    while (gidHolder(uid) || uid === GUEST_UID || uid === USERS_GID) uid++;
  }

  if (isLinkUid(uid)) {
    await cmd.writeError(`user create: uid ${uid} is in the range share links take theirs from (${LINK_UID_BASE} and up)\n`);
    return 1;
  }

  const holder = gidHolder(uid);
  if (holder) {
    await cmd.writeError(`user create: uid ${uid} is already the gid of group '${holder.name}'\n`);
    return 1;
  }

  // Same rule as gids: a uid is what ownership and ACL entries name, so two
  // users sharing one are indistinguishable to every access check.
  const clash = users.find((entry) => entry.node.attrs.uid === uid);
  if (clash) {
    await cmd.writeError(`user create: uid ${uid} is already used by '${clash.name}'\n`);
    return 1;
  }

  try {
    // The account is the administrator's; its primary group is its own, on its uid.
    await cmd.sys.vfs.create<UserAttrs>(
      cmd.access,
      NODE_TYPE_USER,
      cmd.env.USERS_PATH,
      name,
      {
        props: { uid: ADMIN_UID, gid: ADMIN_GID, mode: 0o755 },
        attrs: {
          uid,
          gid: uid,
          name: title || name,
          email: email?.email || undefined,
          description: description || undefined,
        },
      },
    );
    // The home is the user's.
    await cmd.sys.vfs.create(cmd.access, NODE_TYPE_DIRECTORY, cmd.env.HOMES_PATH, name, { props: { uid, gid: uid, mode: HOME_MODE } });

    // Their own group first, created here rather than assumed: the primary gid is the new uid, so
    // without a group carrying that gid the user would be in a group that does not exist.
    if (!ownGroup) {
      const created = await cmd.execute(`group-create ${shq(name)} --gid ${uid} --title ${shq(title || name)}`);
      if (created.code !== 0) {
        await cmd.writeError(`user create: warning: failed to create group '${name}': ${created.stderr}\n`);
      }
    }

    // Then the groups asked for, or the configured defaults — `users` out of the box, which is the
    // grant that lets a new person see what is shared with everyone.
    const requested = flags.groups ?? await defaultUserGroups(cmd.sys.vfs);
    const linked: string[] = [];
    for (const group of new Set([name, ...requested.split(',').map((group) => group.trim()).filter(Boolean)])) {
      const added = await cmd.execute(`group-add-member ${shq(group)} ${shq(name)}`);
      if (added.code === 0) {
        linked.push(group);
      } else {
        await cmd.writeError(`user create: warning: failed to add user to group '${group}': ${added.stderr}\n`);
      }
    }

    const userPath = `${cmd.env.USERS_PATH}/${name}`;

    if (cmd.json) {
      await cmd.writeJSON({ username: name, uid, gid: uid, path: userPath, home, groups: linked } satisfies UserCreated);
    } else {
      await cmd.write(`User '${name}' created\n`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`user create: cannot create user '${name}': ${message}\n`);
    return 1;
  }
};

userCreate.spec = {
  name: 'user-create',
  admin: true,
  effect: 'write' as const,
  description:
    "Create a user account and its home with its own group (an existing group of its name when that group's gid is free as a uid) and link it into its own and its other groups",
  args: [
    {
      name: 'username',
      type: 'string' as const,
      description: 'name of the user to create: lower-case letters, digits and . _ -, starting with a letter or _',
    },
  ],
  flags: [
    {
      name: 'uid',
      type: 'string' as const,
      description: 'numeric user ID',
    },
    {
      name: 'title',
      type: 'string' as const,
      description: 'display title for the user',
    },
    {
      name: 'email',
      type: 'string' as const,
      description: 'e-mail address, which signs in like the username; no other account may have it',
    },
    {
      name: 'description',
      type: 'string' as const,
      description: 'description of the user',
    },
    {
      name: 'groups',
      type: 'string' as const,
      description: 'comma-separated groups to add it to besides its own; empty for none (default CFG_DEFAULT_USER_GROUPS)',
    },
  ],
};
