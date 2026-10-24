import { ADMIN_ACCESS } from '../access/mod.ts';
import { ADMIN_UID, USERS_GID } from '../access/constants.ts';
import { ARCHIVE_PATH } from '../paths.ts';
import type { NodeVFS } from '../../vfs/node-vfs.ts';

/**
 * Create the archive roots a module declares, those that are missing: a directory directly under
 * `/archive`, the admin's and the users group's, mode 775 — what everyone may add content to.
 * One that exists is left as it is, whatever its owner or mode, since someone may have chosen
 * them; and none is ever removed, since it holds the content. Answers the roots it created.
 */
export const ensureArchiveRoots = async (vfs: NodeVFS, roots: string[]): Promise<string[]> => {
  const created: string[] = [];
  for (const root of roots) {
    if (await vfs.exists(ADMIN_ACCESS, root, { follow: false })) continue;
    await vfs.ensure(ADMIN_ACCESS, 'directory', ARCHIVE_PATH, root.slice(ARCHIVE_PATH.length + 1), {
      props: { mode: 0o775, uid: ADMIN_UID, gid: USERS_GID },
    });
    created.push(root);
  }
  return created;
};
