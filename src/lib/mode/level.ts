import { GUEST_GID } from '../access/constants.ts';
import { MaskACL, MaskGroup, MaskOther } from './constants.ts';
import type { Mode, ModeMask, Ownership } from './types.ts';
import type { ShareLevel, SharePreset } from '../api/share.ts';
export type { ShareLevel, SharePreset } from '../api/share.ts';

/**
 * Read `mode` as a level for one class of grantee.
 *
 * Write implies view even when the read bit is somehow missing — a grantee who
 * can change a node can read it back, and reporting that as "no access" would
 * be a lie an effective-access preview then repeats.
 */
export const levelFromMode = (mode: Mode, mask: ModeMask): ShareLevel => {
  if (mode & mask.WRITE) return 'edit';
  if (mode & mask.READ) return 'view';
  return 'none';
};

/**
 * Whether a node sits exactly on the configured default.
 *
 * Kept apart from `sharePreset`, which stays derived from the bits alone. The
 * default is a whole ownership triple, not a shape of the mode, so it cannot be
 * read off a node in isolation — and folding it in would mean that changing the
 * system default silently relabels every node that already matches the new
 * value. The dialog offers "Default" as a thing you can apply, and lights it up
 * when it is what the node currently is.
 *
 * Only the permission bits are compared, not the file-type bits a mode may
 * carry above them.
 */
export const isDefaultShare = (
  ownership: Pick<Ownership, 'mode' | 'uid' | 'gid'>,
  fallback: { mode: Mode; uid: number; gid: number },
): boolean =>
  (ownership.mode & 0o7777) === (fallback.mode & 0o7777) &&
  ownership.uid === fallback.uid &&
  ownership.gid === fallback.gid;

/**
 * `everyone` when visitors are granted it, through the guest's group (`GUEST_GID`). The other bits are the
 * system's: on content they reach the accounts and no one else, so they count as shared.
 */
export const sharePreset = (ownership: Ownership): SharePreset => {
  const acl = ownership.acl ?? [];
  if (acl.some((entry) => entry.gid === GUEST_GID && levelFromMode(entry.mode, MaskACL) !== 'none')) {
    return 'everyone';
  }

  const grantsGroup = levelFromMode(ownership.mode, MaskGroup) !== 'none' || levelFromMode(ownership.mode, MaskOther) !== 'none';
  const grantsAcl = acl.some((entry) => levelFromMode(entry.mode, MaskACL) !== 'none');

  return grantsGroup || grantsAcl ? 'shared' : 'private';
};
