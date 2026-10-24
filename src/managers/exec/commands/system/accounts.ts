/**
 * Account names by uid, for the commands that list what people are running (`ps`, `who`). A uid
 * is what a shell's access carries; the name is what a reader knows the person by.
 */

import { GUEST_UID, GUEST_USERNAME, isAdmin } from '../../../../lib/access/mod.ts';
import type { UserAttrs } from '../../../../vfs/types/user.ts';
import type { Command } from '../../command.ts';

/** A uid's account name, as the caller may read the users directory; the uid itself otherwise. */
export const accountNames = async (cmd: Command): Promise<(uid: number) => string> => {
  const names = new Map<number, string>([[GUEST_UID, GUEST_USERNAME]]);
  try {
    for (const entry of await cmd.sys.vfs.children<UserAttrs>(cmd.access, cmd.env.USERS_PATH)) {
      names.set(entry.node.attrs.uid, entry.name);
    }
  } catch {
    // Not readable by this caller: the uids stand in.
  }
  return (uid) => names.get(uid) ?? String(uid);
};

/** Whether the caller sees everyone's commands and sessions, or only their own. */
export const seesEveryone = (cmd: Command): boolean => isAdmin(cmd.access);
