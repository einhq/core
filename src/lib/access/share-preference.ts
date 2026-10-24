import type { Mode } from '../mode/types.ts';

/** `CFG_USER_DEFAULT_SHARE`'s values; `default` (or unset) leaves the system default alone. */
export type SharePreference = 'default' | 'private' | 'shared' | 'everyone';

/**
 * Narrow or widen the system's default sharing mode to the creator's sharing preference.
 *
 * Every path that creates something as shared applies it, so whatever path made it, it starts out
 * as shared as the creator asked. Owner bits are never reduced: the creator keeps full access
 * however widely it is shared. Others are never given read: the other bits are the system's, and
 * `everyone` — every account — is the `users` group's grant, which the caller adds beside the mode.
 */
export const applySharePreference = (mode: Mode, preference?: string): Mode => {
  switch (preference) {
    case 'private':
      return mode & 0o700;
    case 'shared':
      return (mode & 0o770) | 0o750;
    case 'everyone':
      return (mode & 0o770) | 0o750;
    default:
      return mode;
  }
};
