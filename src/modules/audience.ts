/**
 * Who a module is for: everyone, or the groups it is kept to, as `/etc/modules/<name>.groups`
 * holds them (`mod groups`, `mod install --groups`). A module kept to groups is on the PATH of
 * their members alone (`/etc/bashrc.d/<group>`), in their navigation alone
 * (`/etc/ui/groups/<group>/nav.d`), its pages are routed for them alone, and the shell refuses
 * its commands to anyone else. An administrator is given every module.
 */

import { basename, dirname, join } from '@std/path';
import { toText } from '@std/streams/to-text';
import { ADMIN_ACCESS, ADMIN_GID, ADMIN_UID } from '../lib/access/constants.ts';
import type { Access } from '../lib/access/types.ts';
import { isAdmin } from '../lib/access/verify-access.ts';
import { groupGid } from '../lib/auth/member-gids.ts';
import { MODULE_GROUPS_PATH } from '../lib/paths.ts';
import { NodeNotFoundError } from '../vfs/errors.ts';
import type { NodeVFS } from '../vfs/node-vfs.ts';
import { NODE_TYPE_DIRECTORY } from '../vfs/types/directory.ts';
import { type FileAttrs, NODE_TYPE_FILE } from '../vfs/types/file.ts';

/** The file that keeps `name` to groups. */
const moduleGroupsFile = (name: string): string => join(MODULE_GROUPS_PATH, `${name}.groups`);

/** The names of the groups `name` is kept to, in the order written; none when it is everyone's. */
export const readModuleGroups = async (vfs: NodeVFS, name: string): Promise<string[]> => {
  try {
    const handle = await vfs.open(ADMIN_ACCESS, moduleGroupsFile(name), { mode: 'r' });
    try {
      return [...new Set((await toText(handle.readable)).split('\n').map((line) => line.trim()).filter(Boolean))];
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof NodeNotFoundError) return [];
    throw error;
  }
};

/** Keep `name` to `groups`, or make it everyone's again with none. The administrator's file, readable by all. */
export const writeModuleGroups = async (vfs: NodeVFS, name: string, groups: string[]): Promise<void> => {
  clearModuleAudienceCache();
  const path = moduleGroupsFile(name);
  if (groups.length === 0) {
    try {
      await vfs.unlink(ADMIN_ACCESS, path, MODULE_GROUPS_PATH);
    } catch (error) {
      if (!(error instanceof NodeNotFoundError)) throw error;
    }
    return;
  }
  const bytes = new TextEncoder().encode(`${[...new Set(groups)].join('\n')}\n`);
  await vfs.ensure(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, dirname(MODULE_GROUPS_PATH), basename(MODULE_GROUPS_PATH), { props: { uid: ADMIN_UID, gid: ADMIN_GID, mode: 0o755 } });
  const fileName = `${name}.groups`;
  const attrs: FileAttrs = { name: fileName, mimetype: 'text/plain', size: bytes.length };
  await vfs.ensure<FileAttrs>(ADMIN_ACCESS, NODE_TYPE_FILE, MODULE_GROUPS_PATH, fileName, { props: { uid: ADMIN_UID, gid: ADMIN_GID, mode: 0o644, tier: 'db' }, attrs });
  const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
  try {
    await handle.write(bytes);
  } finally {
    await handle.close();
  }
};

/** The gids of a module's groups, of those that are groups; `undefined` when it is everyone's. */
type Audience = number[] | undefined;

/**
 * How long an answer stays good. The shell asks on every run of a module's command, and the
 * answer changes only by `mod groups`, which clears it; the TTL bounds an edit by hand.
 */
const TTL_MS = 5000;
const cache = new Map<string, { audience: Audience; at: number }>();

/** Forget every module's audience. */
export const clearModuleAudienceCache = (): void => cache.clear();

const audienceOf = async (vfs: NodeVFS, name: string): Promise<Audience> => {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.audience;
  const names = await readModuleGroups(vfs, name);
  let audience: Audience;
  if (names.length > 0) {
    audience = [];
    for (const group of names) {
      const gid = await groupGid(vfs, group);
      if (gid !== undefined) audience.push(gid);
    }
  }
  cache.set(name, { audience, at: Date.now() });
  return audience;
};

/**
 * Whether `access` may use the module `name`: it is everyone's, `access` is an administrator's, or
 * `access` is in one of its groups. A module kept to groups none of which exists is the
 * administrator's alone.
 */
export const mayUseModule = async (vfs: NodeVFS, access: Access, name: string): Promise<boolean> => {
  if (isAdmin(access)) return true;
  const audience = await audienceOf(vfs, name);
  return !audience || audience.some((gid) => access.gids.includes(gid));
};

/** The gids of the groups `name` is kept to, `undefined` when it is everyone's: what the browser sorts its pages by. */
export const moduleGroupGids = (vfs: NodeVFS, name: string): Promise<number[] | undefined> => audienceOf(vfs, name);
