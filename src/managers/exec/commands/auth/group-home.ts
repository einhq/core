import { join } from '@std/path';
import { ADMIN_UID } from '../../../../lib/access/mod.ts';
import type { GroupHome } from '../../../../lib/api/users.ts';
import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '../../../../lib/args/mod.ts';
import { groupRole } from '../../../../lib/auth/roles.ts';
import { GROUP_HOME_MODE, GROUP_HOMES_PATH, groupHomePath } from '../../../../lib/paths.ts';
import { shq } from '../../../../lib/shell-quote/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../../../vfs/types/directory.ts';
import { type GroupAttrs, isGroupNode } from '../../../../vfs/types/group.ts';
import { isUserNode, type UserAttrs } from '../../../../vfs/types/user.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

/**
 * Why `groupname` (gid `gid`) may not have a home, or undefined when it may. The groups boot makes
 * for the system's own use have none, `users` aside; nor has a user's own group, whose member
 * already has a home of their own.
 */
const homeProblem = async (cmd: Command, groupname: string, gid: number): Promise<string | undefined> => {
  const role = groupRole(groupname, gid);
  if (role && role !== 'everyone') return `'${groupname}' is a built-in group`;
  try {
    const user = await cmd.sys.vfs.get<UserAttrs>(cmd.access, join(cmd.env.USERS_PATH, groupname));
    if (isUserNode(user) && user.attrs.uid === gid) return `'${groupname}' is the own group of the user '${groupname}'`;
  } catch {
    // no account of that name
  }
  return undefined;
};

export const groupHome = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, { boolean: ['off'], unknown: collectUnknownFlags(unknown) });
  if (await reportUnknownFlags(cmd, unknown)) return 1;
  const groupname = flags._[0] as string | undefined;
  const fail = async (message: string): Promise<number> => {
    await cmd.writeError(`group home: ${message}\n`);
    return 1;
  };

  if (!groupname) return await fail('missing group name');

  try {
    const groupPath = join(cmd.env.GROUPS_PATH, groupname);
    const group = await cmd.sys.vfs.exists(cmd.access, groupPath) ? await cmd.sys.vfs.get<GroupAttrs>(cmd.access, groupPath) : undefined;
    if (!group || !isGroupNode(group)) return await fail(`group '${groupname}' does not exist`);
    const gid = group.attrs.gid;
    const home = groupHomePath(groupname);
    const exists = await cmd.sys.vfs.exists(cmd.access, home, { follow: false });

    if (flags.off) {
      // Into the administrator's trash rather than gone: what the group kept there can come back.
      if (exists) {
        const trashed = await cmd.execute(`trash put ${shq(home)}`);
        if (trashed.code !== 0) return await fail(`cannot move '${home}' to the trash: ${trashed.stderr.trim()}`);
      }
    } else if (!exists) {
      const problem = await homeProblem(cmd, groupname, gid);
      if (problem) return await fail(problem);
      // The administrator's, so it belongs to no one member, who may leave the group; the group's to fill.
      await cmd.sys.vfs.create(cmd.access, NODE_TYPE_DIRECTORY, GROUP_HOMES_PATH, groupname, {
        props: { uid: ADMIN_UID, gid, mode: GROUP_HOME_MODE },
      });
    }

    const result = { groupname, gid, path: home, home: !flags.off } satisfies GroupHome;
    if (cmd.json) await cmd.writeJSON(result);
    else if (flags.off) await cmd.write(exists ? `Group '${groupname}' has no home now; '${home}' is in the trash\n` : `Group '${groupname}' has no home\n`);
    else await cmd.write(`Group '${groupname}' has its home at ${home}\n`);
    return 0;
  } catch (error) {
    return await fail(error instanceof Error ? error.message : String(error));
  }
};

groupHome.spec = {
  name: 'group-home',
  admin: true,
  effect: 'write' as const,
  description: "Give a group a home, a directory its members share and nobody else sees, or with --off move it to the administrator's trash",
  args: [
    {
      name: 'groupname',
      type: 'group' as const,
      description: 'the group',
    },
  ],
  flags: [
    { name: 'off', type: 'bool' as const, description: "take the group's home away, into the trash" },
  ],
};
