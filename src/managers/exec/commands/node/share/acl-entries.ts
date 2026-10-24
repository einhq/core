import { join } from '@std/path';
import { ADMIN_ACCESS, isLinkUid } from '../../../../../lib/access/mod.ts';
import { getMode, MaskACL } from '../../../../../lib/mode/mod.ts';
import type { Mode, ModeACL } from '../../../../../lib/mode/mod.ts';
import type { GroupAttrs } from '../../../../../vfs/types/group.ts';
import type { UserAttrs } from '../../../../../vfs/types/user.ts';
import type { Command } from '../../../command.ts';

type GranteeKind = 'u' | 'g';

/** What `-m` / `-x` / `-b` were asked for, before any of it is resolved. */
type AclEdit = {
  /** `u:<user>:<perms>` or `g:<group>:<perms>` — added, or replacing the same grantee. */
  modify?: string[];
  /** `u:<user>` or `g:<group>`. */
  remove?: string[];
  /** Drop the existing user and group entries before applying the rest. */
  clear?: boolean;
  /** Drop the share links' entries too, so no link opens the node. */
  dropLinks?: boolean;
};

/** An edit with its names resolved to ids, ready to apply to any node's list (`editAcl`). */
export type ResolvedAclEdit = {
  clear: boolean;
  dropLinks: boolean;
  remove: { kind: GranteeKind; id: number }[];
  modify: { kind: GranteeKind; id: number; mode: Mode }[];
};

const parseKind = (raw: string, spec: string): GranteeKind => {
  if (raw === 'u' || raw === 'user') return 'u';
  if (raw === 'g' || raw === 'group') return 'g';
  throw new Error(`invalid entry type in "${spec}" (use u:<user> or g:<group>; share-link gives and takes links)`);
};

/**
 * Resolve a user or group name — or a bare numeric id — to its uid/gid.
 *
 * Read as admin on purpose: naming a group in a grant must work for a user who
 * cannot list `/etc/groups` themselves, and learning that a group exists is not
 * the same as gaining anything from it.
 */
export const resolveGrantee = async (cmd: Command, kind: GranteeKind, name: string): Promise<number> => {
  if (/^\d+$/.test(name)) return Number.parseInt(name, 10);

  if (kind === 'u') {
    const node = await cmd.sys.vfs.get<UserAttrs>(ADMIN_ACCESS, join(cmd.env.USERS_PATH, name));
    return node.attrs.uid;
  }

  const node = await cmd.sys.vfs.get<GroupAttrs>(ADMIN_ACCESS, join(cmd.env.GROUPS_PATH, name));
  return node.attrs.gid;
};

/**
 * Read `-b`, `-x` and `-m` into one edit, its names resolved once however many nodes it is
 * applied to.
 *
 * Shared by `acl` and `share-set` so the spec syntax has one parser: the
 * sharing dialog sends `-b` plus the full set of `-m` it wants, which is the
 * same operation the command line spells out by hand.
 */
export const resolveAclEdit = async (cmd: Command, edit: AclEdit): Promise<ResolvedAclEdit> => {
  const resolved: ResolvedAclEdit = { clear: edit.clear === true, dropLinks: edit.dropLinks === true, remove: [], modify: [] };

  for (const spec of edit.remove ?? []) {
    const parts = spec.split(':');
    const kind = parseKind(parts[0], spec);
    const name = parts[1];
    if (!name) throw new Error(`missing user/group in "${spec}"`);
    resolved.remove.push({ kind, id: await resolveGrantee(cmd, kind, name) });
  }

  for (const spec of edit.modify ?? []) {
    const parts = spec.split(':');
    const kind = parseKind(parts[0], spec);
    const name = parts[1];
    if (!name) throw new Error(`missing user/group in "${spec}"`);
    const permStr = parts[2];
    if (permStr === undefined) throw new Error(`missing permissions in "${spec}" (e.g. ${parts[0]}:${name}:rwx)`);
    resolved.modify.push({ kind, id: await resolveGrantee(cmd, kind, name), mode: getMode(permStr, MaskACL) });
  }

  return resolved;
};

const names = (entry: ModeACL, kind: GranteeKind, id: number): boolean => kind === 'u' ? entry.uid === id : entry.gid === id;

/**
 * One node's list after an edit.
 *
 * `clear` drops the user and group entries and keeps share links' (`isLinkUid`): `share-link`
 * gives and takes links, so re-sharing a folder from the dialog — `-b` and the full list — leaves
 * a link on it, or on anything inside it, working. `dropLinks` takes those away too: a photo given
 * sharing of its own inside a shared album is not opened by the album's link.
 */
export const editAcl = (current: readonly ModeACL[], edit: ResolvedAclEdit): ModeACL[] => {
  let entries = edit.clear ? current.filter((entry) => isLinkUid(entry.uid)) : [...current];
  if (edit.dropLinks) entries = entries.filter((entry) => !isLinkUid(entry.uid));

  for (const { kind, id } of edit.remove) {
    entries = entries.filter((entry) => !names(entry, kind, id));
  }

  for (const { kind, id, mode } of edit.modify) {
    // Replace any existing entry for the same grantee (idempotent update).
    entries = entries.filter((entry) => !names(entry, kind, id));
    entries.push(kind === 'u' ? { uid: id, mode } : { gid: id, mode });
  }

  return entries;
};

/** True when the edit asks for anything at all. */
export const hasAclEdit = (edit: AclEdit): boolean => Boolean(edit.clear || edit.dropLinks || edit.modify?.length || edit.remove?.length);
