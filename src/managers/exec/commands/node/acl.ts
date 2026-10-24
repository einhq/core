import { parseArgs } from '../../../../lib/args/mod.ts';
import { isLinkUid } from '../../../../lib/access/mod.ts';
import { resolve } from '@std/path';
import { MaskACL, MaskGroup, MaskOther, MaskOwner, modeStringMask } from '../../../../lib/mode/mod.ts';
import { GroupAttrs } from '../../../../vfs/types/group.ts';
import { UserAttrs } from '../../../../vfs/types/user.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { editAcl, resolveAclEdit } from './share/acl-entries.ts';
import { applySubtree } from './share/walk.ts';

export const acl = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['b', 'L', 'r'],
    collect: ['m', 'x'],
  });

  const modifySpecs = flags.m as string[];
  const removeSpecs = flags.x as string[];
  const clearAll = flags.b;
  const path = resolve(cmd.cwd, flags._[0] as string || '.');

  const resolveOpts = {
    readlink: flags.L,
  };

  const isEdit = clearAll || (modifySpecs?.length ?? 0) > 0 || (removeSpecs?.length ?? 0) > 0;

  try {
    const node = await cmd.sys.vfs.get(cmd.access, path, resolveOpts);

    if (isEdit) {
      // Names resolved once; each node, the subtree's too with -r, edits its own list.
      const edit = await resolveAclEdit(cmd, { modify: modifySpecs, remove: removeSpecs, clear: clearAll });

      const interrupt = new AbortController();
      cmd.onInterrupt(() => interrupt.abort());

      const result = await applySubtree(cmd.sys.vfs, cmd.access, path, { acl: (current) => editAcl(current, edit) }, {
        rootResolve: resolveOpts,
        recursive: flags.r,
        signal: interrupt.signal,
      });

      for (const failure of result.failures) {
        await cmd.writeError(`acl: ${failure.path}: ${failure.message}\n`);
      }

      if (cmd.json) {
        await cmd.writeJSON({ ok: true, updated: result.updated, pinned: result.pinned, skipped: result.skipped, failed: result.failed });
      }

      return result.failed > 0 ? 1 : 0;
    }

    const entries = node.props.acl ?? [];

    if (cmd.json) {
      await cmd.writeJSON(entries);
      return 0;
    }

    // Resolve uid/gid to names for a readable listing.
    const ucache: Record<number, string> = {};
    const gcache: Record<number, string> = {};

    try {
      const users = await cmd.sys.vfs.children<UserAttrs>(cmd.access, cmd.env.USERS_PATH);
      for (const user of users) ucache[user.node.attrs.uid] = user.name;
    } catch { /* users not accessible */ }

    try {
      const groups = await cmd.sys.vfs.children<GroupAttrs>(cmd.access, cmd.env.GROUPS_PATH);
      for (const group of groups) gcache[group.node.attrs.gid] = group.name;
    } catch { /* groups not accessible */ }

    const owner = ucache[node.props.uid] ?? String(node.props.uid);
    const group = gcache[node.props.gid] ?? String(node.props.gid);

    const lines: string[] = [
      `# node: ${path}`,
      `# owner: ${owner} (${node.props.uid})`,
      `# group: ${group} (${node.props.gid})`,
      `user::${modeStringMask(node.props.mode, MaskOwner)}`,
      `group::${modeStringMask(node.props.mode, MaskGroup)}`,
      `other::${modeStringMask(node.props.mode, MaskOther)}`,
    ];

    for (const entry of entries) {
      if (isLinkUid(entry.uid)) {
        // A share link's principal, by its uid: `share-link list` says what it opens.
        lines.push(`link:${entry.uid}:${modeStringMask(entry.mode, MaskACL)}`);
      } else if (entry.uid !== undefined) {
        const name = ucache[entry.uid] ?? String(entry.uid);
        lines.push(`user:${name}:${modeStringMask(entry.mode, MaskACL)}`);
      }
      if (entry.gid !== undefined) {
        const name = gcache[entry.gid] ?? String(entry.gid);
        lines.push(`group:${name}:${modeStringMask(entry.mode, MaskACL)}`);
      }
    }

    await cmd.write(lines.join('\n') + '\n');

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`acl: ${path}: ${message}\n`);
    return 1;
  }
};

acl.spec = {
  name: 'acl',
  effect: 'read' as const,
  description: 'Display or modify a node access control list',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      description: 'path to node',
    },
  ],
  flags: [
    {
      name: 'm',
      writes: true,
      type: 'string' as const,
      description: 'add or modify an entry (u:<user>:<perms> or g:<group>:<perms>)',
    },
    {
      name: 'x',
      writes: true,
      type: 'string' as const,
      description: 'remove an entry (u:<user> or g:<group>)',
    },
    { name: 'b', writes: true, type: 'bool' as const, description: 'remove the user and group entries (share links stay: share-link removes them)' },
    { name: 'r', type: 'bool' as const, description: 'apply to the whole subtree, skipping nodes that hold their own access' },
    { name: 'L', type: 'bool' as const, description: 'do not follow symbolic links' },
  ],
};
