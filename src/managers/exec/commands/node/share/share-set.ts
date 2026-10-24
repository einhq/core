import { resolve } from '@std/path';
import { parseArgs } from '../../../../../lib/args/mod.ts';
import { ACCESS_PINNED_ATTR, resolveDefaultOwnership } from '../../../../../lib/access/mod.ts';
import type { ShareSetResult } from '../../../../../lib/api/share.ts';
import { chmodToMode } from '../../../../../lib/mode/mod.ts';
import type { Node, NodeAttrsUpdate, NodePropsUpdate } from '../../../../../vfs/mod.ts';
import type { Command } from '../../../command.ts';
import type { CmdReturn } from '../../../types.ts';
import { editAcl, hasAclEdit, resolveAclEdit, type ResolvedAclEdit, resolveGrantee } from './acl-entries.ts';
import { applySubtree, applySubtrees, type SubtreeResult } from './walk.ts';

/** Refusals kept for the answer across every path; the counts stay exact past this. */
const MAX_FAILURES = 20;

/**
 * Set nodes' access, and by default everything below each of them, in one walk per node.
 *
 * `chmod -r` plus an `acl -r` per grantee would walk the same subtree once for
 * each of them; a sharing dialog changing three rows on a folder of 300 photos
 * would pay four passes to express one intent. So this takes the whole desired
 * state — mode, the access list's edit, and the pin — and writes it in a single
 * descent.
 *
 * `-m`, `-x` and `-b` edit each node's own list, as `setfacl -R` does: what a node lists beyond
 * the edit — a share link given to a folder inside — stays. `--reference` gives every node the
 * reference's list as it is.
 *
 * The pin is written to the **named nodes only**. Pinning a folder is a statement
 * about the folder; stamping it onto every file inside would make the next
 * change from above a no-op, which is the opposite of what was asked.
 */
export const shareSet = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['b', 'L', 'pin', 'unpin', 'no-recursive', 'strict', 'default-owner', 'drop-links'],
    string: ['mode', 'owner', 'group', 'reference'],
    collect: ['m', 'x'],
  });

  const paths = (flags._.length > 0 ? flags._ : ['.']).map((arg) => resolve(cmd.cwd, String(arg)));
  const resolveOpts = { readlink: flags.L };
  const recursive = !flags['no-recursive'];

  if (flags.pin && flags.unpin) {
    await cmd.writeError('share-set: --pin and --unpin are mutually exclusive\n');
    return 1;
  }

  if (flags['default-owner'] && (flags.owner !== undefined || flags.group !== undefined)) {
    await cmd.writeError('share-set: --default-owner cannot be combined with --owner or --group\n');
    return 1;
  }

  const edit = { modify: flags.m as string[] | undefined, remove: flags.x as string[] | undefined, clear: flags.b, dropLinks: flags['drop-links'] };

  const reference = flags.reference as string | undefined;
  if (
    reference !== undefined &&
    (flags.mode !== undefined || flags.owner !== undefined || flags.group !== undefined || flags['default-owner'] || hasAclEdit(edit))
  ) {
    await cmd.writeError('share-set: --reference cannot be combined with --mode, --owner, --group, --default-owner, -m, -x, -b or --drop-links\n');
    return 1;
  }

  const defaultOwner = flags['default-owner'];
  const changesProps = reference !== undefined || flags.mode !== undefined || flags.owner !== undefined || flags.group !== undefined ||
    defaultOwner || hasAclEdit(edit);

  const attrs: NodeAttrsUpdate = {};
  if (flags.pin) attrs[ACCESS_PINNED_ATTR] = true;
  if (flags.unpin) attrs[ACCESS_PINNED_ATTR] = null;
  const changesAttrs = Object.keys(attrs).length > 0;

  if (!changesProps && !changesAttrs) {
    await cmd.writeError('share-set: nothing to change (use --mode, --owner, --group, --default-owner, --reference, -m, -x, -b, --drop-links, --pin or --unpin)\n');
    return 1;
  }

  // What every path is given, resolved once.
  let like: Node | undefined;
  let aclEdit: ResolvedAclEdit | undefined;
  let owner: number | undefined;
  let group: number | undefined;
  try {
    like = reference !== undefined ? await cmd.sys.vfs.get(cmd.access, resolve(cmd.cwd, reference)) : undefined;
    aclEdit = hasAclEdit(edit) ? await resolveAclEdit(cmd, edit) : undefined;
    owner = flags.owner !== undefined ? await resolveGrantee(cmd, 'u', flags.owner) : undefined;
    group = flags.group !== undefined ? await resolveGrantee(cmd, 'g', flags.group) : undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`share-set: ${message}\n`);
    return 1;
  }

  const interrupt = new AbortController();
  cmd.onInterrupt(() => interrupt.abort());

  const total: ShareSetResult = { ok: true, updated: 0, pinned: 0, skipped: 0, failed: 0, failures: [] };
  const fail = (path: string, message: string) => {
    total.failed++;
    if (total.failures.length < MAX_FAILURES) total.failures.push({ path, message });
  };
  let refused = 0;
  const add = (path: string, outcome: PromiseSettledResult<SubtreeResult>) => {
    if (outcome.status === 'rejected') {
      refused++;
      fail(path, outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason));
      return;
    }
    const result = outcome.value;
    total.updated += result.updated;
    total.pinned += result.pinned;
    total.skipped += result.skipped;
    total.failed += result.failed - result.failures.length;
    for (const failure of result.failures) fail(failure.path, failure.message);
  };

  // Shared as another node is: its group, bits and access control list, the same for every path,
  // so all of them are one walk. The owner stays, as with `--group` — giving a node away is the
  // administrator's.
  if (like) {
    const props: NodePropsUpdate = { gid: like.props.gid, mode: like.props.mode, acl: like.props.acl ?? [] };
    const settled = await applySubtrees(cmd.sys.vfs, cmd.access, paths, { props, ...(changesAttrs ? { rootAttrs: attrs } : {}) }, {
      recursive,
      signal: interrupt.signal,
      rootResolve: resolveOpts,
    });
    settled.forEach((outcome, i) => add(paths[i], outcome));
  } else {
    for (const path of paths) {
      if (interrupt.signal.aborted) break;

      try {
        const node = await cmd.sys.vfs.get(cmd.access, path, resolveOpts);

        const props: NodePropsUpdate = {};

        if (flags.mode !== undefined) {
          props.mode = chmodToMode(flags.mode, node.props.mode);
        }

        // Owner and group ride along with the mode rather than being a separate
        // recursive `chown`: the sharing dialog's "Default" changes the group and
        // the bits together, and two descents would double the walk and leave a
        // window where a node carried the new bits under its previous group.
        if (owner !== undefined) props.uid = owner;
        if (group !== undefined) props.gid = group;

        // Resolved against the node, as `share-info` reports it: an unset setting keeps its owner or
        // group.
        if (defaultOwner) {
          const defaults = await resolveDefaultOwnership(cmd, { uid: node.props.uid, gid: node.props.gid, gids: [] });
          props.uid = defaults.uid;
          props.gid = defaults.gid;
        }

        const result = await applySubtree(
          cmd.sys.vfs,
          cmd.access,
          path,
          {
            ...(Object.keys(props).length > 0 ? { props } : {}),
            ...(aclEdit ? { acl: (current) => editAcl(current, aclEdit) } : {}),
            ...(changesAttrs ? { rootAttrs: attrs } : {}),
          },
          {
            // With only a pin to write there is nothing for the subtree to receive.
            recursive: recursive && changesProps,
            signal: interrupt.signal,
            rootResolve: resolveOpts,
            // The configured owner and group are the administrator's choice, which the caller may not
            // make themselves: the server applies them to every node the caller may write.
            ...(defaultOwner ? { writer: { ...cmd.access, admin: true } } : {}),
          },
        );

        add(path, { status: 'fulfilled', value: result });
      } catch (reason) {
        add(path, { status: 'rejected', reason });
      }
    }
  }

  // Refused on every node it was given: nothing changed, and that is this command failing.
  if (refused === paths.length) {
    for (const failure of total.failures) await cmd.writeError(`share-set: ${failure.path}: ${failure.message}\n`);
    return 1;
  }

  if (cmd.json) {
    await cmd.writeJSON(total satisfies ShareSetResult);
  } else {
    await cmd.writeLn(`updated ${total.updated}, kept own access ${total.pinned}, skipped ${total.skipped}, failed ${total.failed}`);
    for (const failure of total.failures) {
      await cmd.writeError(`share-set: ${failure.path}: ${failure.message}\n`);
    }
  }

  // A node that refused is reported, not fatal. The counts *are* this command's
  // answer, and the API shell drops the payload of any command that exits
  // non-zero — so failing here would hide a mostly-successful apply from the
  // dialog that asked for it. `--strict` restores the `chmod -R` habit for
  // scripts that want it.
  return flags.strict && total.failed > 0 ? 1 : 0;
};

shareSet.spec = {
  name: 'share-set',
  effect: 'write' as const,
  description: 'Set who has access to nodes and everything below them',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      variadic: true,
      description: 'paths to nodes',
    },
  ],
  flags: [
    {
      name: 'mode',
      type: 'string' as const,
      description: 'mode to set, octal or symbolic (e.g. 0750 or g+rx)',
    },
    {
      name: 'owner',
      type: 'string' as const,
      description: 'user to own the node, by name or uid (administrator only)',
    },
    {
      name: 'group',
      type: 'string' as const,
      description: 'group for the node, by name or gid (one the caller is in, unless administrator)',
    },
    {
      name: 'default-owner',
      type: 'bool' as const,
      description: 'give the node the configured default owner and group (CFG_DEFAULT_SHARE_OWNER, CFG_DEFAULT_SHARE_GROUP)',
    },
    {
      name: 'reference',
      type: 'path' as const,
      description: 'share the node as this one is: its group, mode and acl (the owner stays)',
    },
    {
      name: 'm',
      type: 'string' as const,
      description: 'add or modify an entry (u:<user>:<perms> or g:<group>:<perms>)',
    },
    {
      name: 'x',
      type: 'string' as const,
      description: 'remove an entry (u:<user> or g:<group>)',
    },
    { name: 'b', type: 'bool' as const, description: 'remove the user and group entries before applying -m (share links stay)' },
    { name: 'drop-links', type: 'bool' as const, description: "remove the share links' entries too, so no link opens the nodes" },
    { name: 'pin', type: 'bool' as const, description: 'hold this node against access changes made further up' },
    { name: 'unpin', type: 'bool' as const, description: 'let access changes from further up reach this node again' },
    { name: 'no-recursive', type: 'bool' as const, description: 'change only this node, not what is below it' },
    { name: 'strict', type: 'bool' as const, description: 'exit non-zero when any node below could not be changed' },
    { name: 'L', type: 'bool' as const, description: 'do not follow symbolic links' },
  ],
};
