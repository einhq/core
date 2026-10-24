import { basename, resolve } from '@std/path';
import { parseArgs } from '../../../../../lib/args/mod.ts';
import { ACCESS_PINNED_ATTR, ADMIN_UID, isAdmin, isLinkUid, isPinned, isVisitor, resolveDefaultOwnership, verifyAccess } from '../../../../../lib/access/mod.ts';
import { groupRole } from '../../../../../lib/auth/roles.ts';
import { guestMayBrowse } from '../../../../../lib/config/mod.ts';
import { isDefaultShare, levelFromMode, MaskACL, MaskGroup, MaskOther, MaskOwner, sharePreset } from '../../../../../lib/mode/mod.ts';
import type { NodeQueryCursor } from '../../../../../vfs/mod.ts';
import type { Command } from '../../../command.ts';
import type { CmdReturn } from '../../../types.ts';
import { effectiveAccess, readDirectory } from './effective.ts';
import { allLinks, describeLink, titleOf, userNames } from './links.ts';
import { EXCEPTIONS_SHOWN, type ShareException, type ShareGrant, type ShareInfo, type ShareLink } from '../../../../../lib/api/share.ts';

/** Pinned nodes read per query page; few nodes are pinned, so most answers take one. */
const PINNED_PAGE = 500;

/**
 * The nodes below `path` that keep their own sharing and the caller can read: found through the
 * index on the pin rather than by walking the subtree, since a pin is rare and a subtree is not.
 */
const exceptionsBelow = async (cmd: Command, path: string): Promise<{ shown: ShareException[]; count: number }> => {
  const prefix = path === '/' ? '/' : `${path}/`;
  const shown: ShareException[] = [];
  let count = 0;
  let after: NodeQueryCursor | undefined;

  for (;;) {
    const page = await cmd.sys.vfs.query(cmd.access, {
      where: [{ ref: ACCESS_PINNED_ATTR, op: 'eq', value: true }],
      ...(after ? { after } : {}),
      limit: PINNED_PAGE,
    });

    for (const hit of page) {
      if (!hit.absPath.startsWith(prefix)) continue;
      count++;
      if (shown.length < EXCEPTIONS_SHOWN) {
        shown.push({ path: hit.absPath, type: hit.node.type, name: basename(hit.absPath), preset: sharePreset(hit.node.props) });
      }
    }

    if (page.length < PINNED_PAGE) break;
    const last = page[page.length - 1];
    after = { value: last.sortValue, id: last.id };
  }

  shown.sort((a, b) => a.path.localeCompare(b.path));
  return { shown, count };
};

export const shareInfo = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { boolean: ['L'] });
  const path = resolve(cmd.cwd, flags._[0] as string || '.');
  const resolveOpts = { readlink: flags.L };

  // Who has access names people and groups, which a visitor who has not signed in — one sent a
  // share link among them — has no business learning.
  if (isVisitor(cmd.access)) {
    await cmd.writeError(`share-info: ${path}: sign in to see who has access\n`);
    return 1;
  }

  try {
    const node = await cmd.sys.vfs.get(cmd.access, path, resolveOpts);
    const { groups, users } = await readDirectory(cmd.sys.vfs, cmd.access, cmd.env.GROUPS_PATH, cmd.env.USERS_PATH);
    const canInspectGroupMembers = isAdmin(cmd.access);

    // Resolved against the node's owner rather than the caller: "Default" has
    // to mean the same thing to everyone looking at the same node, and an
    // unset owner setting means "whoever made it".
    const defaults = await resolveDefaultOwnership(cmd, { uid: node.props.uid, gid: node.props.gid, gids: [] });

    const owner = users.find((user) => user.uid === node.props.uid);
    const primary = groups.find((group) => group.gid === node.props.gid);
    const canEdit = verifyAccess(cmd.access, node.props, 'w');

    const names = await userNames(cmd.sys.vfs, cmd.env.USERS_PATH);
    const links: ShareLink[] = (await allLinks(cmd))
      .filter((entry) => entry.node.attrs.target === node.id)
      .map((entry) => describeLink(entry.name, entry.node.attrs, path, canEdit, names))
      .sort((a, b) => b.createdAt - a.createdAt);

    const exceptions = await exceptionsBelow(cmd, path);

    const grants: ShareGrant[] = [];

    // The node's own group first: it is the one grant that is not an ACL entry,
    // and the one the dialog badges as primary. Emitted even when no group node
    // carries that gid — the bits still grant whatever they grant, and a dialog
    // that omitted the row would quietly clear them on the next save.
    const primaryName = primary?.groupname ?? String(node.props.gid);
    grants.push({
      kind: 'group',
      id: node.props.gid,
      name: primaryName,
      title: primary?.title,
      level: levelFromMode(node.props.mode, MaskGroup),
      source: 'primary',
      members: primary?.members.length,
      role: groupRole(primaryName, node.props.gid),
    });

    // Link entries are not grants to anyone the dialog lists: `links` answers for them.
    for (const entry of node.props.acl ?? []) {
      if (isLinkUid(entry.uid)) continue;
      const level = levelFromMode(entry.mode, MaskACL);

      if (entry.gid !== undefined) {
        const group = groups.find((candidate) => candidate.gid === entry.gid);
        const name = group?.groupname ?? String(entry.gid);
        grants.push({
          kind: 'group',
          id: entry.gid,
          name,
          title: group?.title,
          level,
          source: 'acl',
          members: group?.members.length,
          role: groupRole(name, entry.gid),
        });
      }

      if (entry.uid !== undefined) {
        const user = users.find((candidate) => candidate.uid === entry.uid);
        grants.push({
          kind: 'user',
          id: entry.uid,
          name: user?.username ?? String(entry.uid),
          title: user?.title,
          path: user?.path,
          ...(user?.personPath ? { personPath: user.personPath } : {}),
          level,
          source: 'acl',
        });
      }
    }

    const info: ShareInfo = {
      path,
      type: node.type,
      title: titleOf(node, path),
      owner: {
        uid: node.props.uid,
        username: owner?.username,
        title: owner?.title,
        path: owner?.path,
        ...(owner?.personPath ? { personPath: owner.personPath } : {}),
        level: levelFromMode(node.props.mode, MaskOwner),
      },
      group: { gid: node.props.gid, groupname: primary?.groupname },
      mode: node.props.mode,
      canEdit,
      preset: sharePreset(node.props),
      everyone: levelFromMode(node.props.mode, MaskOther),
      pinned: isPinned(node),
      grants,
      default: { ...defaults, active: isDefaultShare(node.props, defaults) },
      // Group memberships and the corresponding effective-person list reveal
      // who belongs to what group. The dialog needs neither for non-admins.
      effective: canInspectGroupMembers ? effectiveAccess(users, node.props, groups) : [],
      // Whom the dialog can add: only for someone who may add anybody.
      groups: !canEdit ? [] : groups.map((group) => ({
        groupname: group.groupname,
        gid: group.gid,
        title: group.title,
        members: group.members.length,
        role: groupRole(group.groupname, group.gid),
      })),
      users: !canEdit ? [] : users.filter((user) => !user.inactive).map((user) => ({
        path: user.path,
        ...(user.personPath ? { personPath: user.personPath } : {}),
        username: user.username,
        uid: user.uid,
        title: user.title,
        ...(canInspectGroupMembers ? { gids: user.gids, admin: user.uid === ADMIN_UID } : {}),
      })),
      guestBrowsing: await guestMayBrowse(cmd.sys.vfs),
      links,
      exceptions: exceptions.shown,
      exceptionCount: exceptions.count,
    };

    if (cmd.json) {
      await cmd.writeJSON(info);
    } else {
      await cmd.writeYAML(info);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`share-info: ${path}: ${message}\n`);
    return 1;
  }
};

shareInfo.spec = {
  name: 'share-info',
  effect: 'read' as const,
  description: 'Show who has access to a node, and through what',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      description: 'path to node',
    },
  ],
  flags: [
    { name: 'L', type: 'bool' as const, description: 'do not follow symbolic links' },
  ],
};
