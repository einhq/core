import { GROUPS_PATH, USERS_PATH } from '../paths.ts';
import { join } from '@std/path';
import type { GroupId, Mode, UserId } from '../mode/types.ts';
import type { NodeVFS } from '../../vfs/node-vfs.ts';
import type { GroupAttrs } from '../../vfs/types/group.ts';
import type { UserAttrs } from '../../vfs/types/user.ts';
import { CORE_OPTIONS } from '../config/options.ts';
import { readSettings } from '../config/read-settings.ts';
import { ADMIN_ACCESS } from './constants.ts';
import type { Access } from './types.ts';

const MODE_KEY = 'CFG_DEFAULT_SHARE_MODE';
const OWNER_KEY = 'CFG_DEFAULT_SHARE_OWNER';
const GROUP_KEY = 'CFG_DEFAULT_SHARE_GROUP';

/** The value `src/lib/config/options.ts` declares for a setting no file holds. */
const declaredDefault = (key: string): string => CORE_OPTIONS.find((option) => option.key === key)?.default ?? '';

/**
 * The default sharing: the ownership anything created as shared starts with, and what the sharing
 * dialog's "Default" option applies.
 *
 * A triple rather than a mode alone: on a family install the interesting part
 * of "who can see something new" is almost always the *group*, not the bits —
 * `0755` on a per-user group shares with nobody, and the same bits on `users`
 * share with the household.
 */
export type DefaultOwnership = {
  mode: Mode;
  uid: UserId;
  gid: GroupId;
  /** The configured names, for a dialog that wants to say who "Default" means. */
  ownerName?: string;
  groupName?: string;
};

/** Enough of a command to resolve against — core's `Command` and a module's both satisfy it. */
type OwnershipContext = {
  readonly sys: { readonly vfs: NodeVFS };
  readonly env: Record<string, string>;
};

/**
 * Resolve the configured default against the person creating something.
 *
 * Names rather than numeric ids in the file, resolved here: `users` survives a
 * uid renumbering and reads as itself in `/etc/config`. A setting no file holds
 * takes its declared default, as `config get` reports it; an empty owner or
 * group means "whoever is creating it".
 *
 * Read as admin, like `resolveGrantee`: what a person creates must land in the
 * configured group whether or not they may list `/etc/groups` themselves.
 * A name that does not resolve falls back to the creator rather than failing —
 * a mistyped group in a settings file should not make anything uncreatable.
 *
 * The settings come from `/etc/config` rather than from the shell's own
 * environment, so an administrator who changes the default and then opens a
 * sharing dialog in the same session is shown what they just set.
 */
export const resolveDefaultOwnership = async (ctx: OwnershipContext, creator: Access): Promise<DefaultOwnership> => {
  const vfs = ctx.sys.vfs;
  const settings = await readSettings(ctx, ADMIN_ACCESS, { user: false });

  const parsedMode = Number.parseInt(settings[MODE_KEY] ?? '', 8);

  const ownerName = (settings[OWNER_KEY] ?? declaredDefault(OWNER_KEY)) || undefined;
  const groupName = (settings[GROUP_KEY] ?? declaredDefault(GROUP_KEY)) || undefined;

  let uid = creator.uid;
  if (ownerName) {
    try {
      const node = await vfs.get<UserAttrs>(ADMIN_ACCESS, join(ctx.env.USERS_PATH || USERS_PATH, ownerName));
      uid = node.attrs.uid;
    } catch {
      // Falls back to the creator — see above.
    }
  }

  let gid = creator.gid;
  if (groupName) {
    try {
      const node = await vfs.get<GroupAttrs>(ADMIN_ACCESS, join(ctx.env.GROUPS_PATH || GROUPS_PATH, groupName));
      gid = node.attrs.gid;
    } catch {
      // Falls back to the creator's primary group.
    }
  }

  return {
    mode: Number.isNaN(parsedMode) ? Number.parseInt(declaredDefault(MODE_KEY), 8) : parsedMode,
    uid,
    gid,
    ownerName,
    groupName,
  };
};
