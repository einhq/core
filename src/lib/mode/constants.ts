import { ModeMask } from './types.ts';

export const MaskOwner: ModeMask = {
  READ: 0o400,
  WRITE: 0o200,
  EXEC: 0o100,
};

export const MaskGroup: ModeMask = {
  READ: 0o040,
  WRITE: 0o020,
  EXEC: 0o010,
};

export const MaskOther: ModeMask = {
  READ: 0o004,
  WRITE: 0o002,
  EXEC: 0o001,
};

export const MaskACL: ModeMask = {
  READ: 0o004,
  WRITE: 0o002,
  EXEC: 0o001,
};

/**
 * The sticky bit, on a directory: writing it is not enough to remove or rename what is in it; only an
 * entry's owner, the directory's owner, an administrator or whoever may write the entry may — the
 * last not for an entry that is itself sticky. `/tmp` (1777), `/archive` and its roots (1771) have it.
 */
export const MODE_STICKY = 0o1000;

export const MaskWhoKeys = ['u', 'g', 'o'] as const;

export const MaskWho: Record<string, ModeMask> = {
  u: MaskOwner,
  g: MaskGroup,
  o: MaskOther,
};
