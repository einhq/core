/**
 * What an account leaves behind. Its home while it is disabled: one that holds nothing but
 * directories is removed, so an account nobody used leaves nothing (it is archived), and it is made
 * again, empty, when the account is enabled; a home with anything else in it — a file, a link —
 * stays as it is. And whether anything outside the account still names its uid, which
 * `user-delete --unused` asks before deleting it.
 */
import { dirname, join } from '@std/path';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { HOME_MODE } from '../../../../lib/paths.ts';
import { isPathWithin } from '../../../../vfs/audit.ts';
import type { NodeId } from '../../../../vfs/node.ts';
import { NODE_TYPE_DIRECTORY } from '../../../../vfs/types/directory.ts';
import { GroupAttrs } from '../../../../vfs/types/group.ts';
import { NODE_TYPE_SOFTLINK } from '../../../../vfs/types/softlink.ts';
import type { Command } from '../../command.ts';

/** Children read per page while walking a tree. */
const PAGE = 200;

/** Audit and access-log records read to tell whether an account did anything outside its own nodes. */
const RECORDS = 1000;

type Vfs = Command['sys']['vfs'];

/**
 * The ids of the tree at `path`, itself included, read without following softlinks; none when
 * there is no such node. With `directoriesOnly`, null as soon as it holds anything but directories.
 */
const treeIds = async (vfs: Vfs, path: string, directoriesOnly: boolean): Promise<NodeId[] | null> => {
  const node = await vfs.get(ADMIN_ACCESS, path, { follow: false }).catch(() => undefined);
  if (!node) return [];
  const ids = [node.id];
  const walk = async (dir: string): Promise<boolean> => {
    let after: string | undefined;
    while (true) {
      const page = await vfs.children(ADMIN_ACCESS, dir, { page: { limit: PAGE, ...(after !== undefined ? { after } : {}) } });
      for (const entry of page) {
        if (directoriesOnly && entry.node.type !== NODE_TYPE_DIRECTORY) return false;
        ids.push(entry.node.id);
        if (entry.node.type !== NODE_TYPE_SOFTLINK && !(await walk(`${dir}/${entry.name}`))) return false;
      }
      if (page.length < PAGE) return true;
      after = page[page.length - 1].name;
    }
  };
  return (await walk(path)) ? ids : null;
};

/** `username`'s home removed when it holds nothing but directories; whether it was. */
export const removeEmptyHome = async (cmd: Command, username: string): Promise<boolean> => {
  const home = join(cmd.env.HOMES_PATH, username);
  const ids = await treeIds(cmd.sys.vfs, home, true);
  if (ids === null || ids.length === 0) return false;
  await cmd.sys.vfs.unlink(cmd.access, home, dirname(home), { recursive: true });
  return true;
};

/** `username`'s home made, theirs and empty as `user-create` makes it, when there is none; whether it was. */
export const ensureHome = async (cmd: Command, username: string, uid: number): Promise<boolean> => {
  const home = join(cmd.env.HOMES_PATH, username);
  if (await cmd.sys.vfs.exists(ADMIN_ACCESS, home, { follow: false })) return false;
  await cmd.sys.vfs.create(cmd.access, NODE_TYPE_DIRECTORY, cmd.env.HOMES_PATH, username, { props: { uid, gid: uid, mode: HOME_MODE } });
  return true;
};

/** `n` and the noun for it, singular for one. */
const countOf = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * What still names the account `username` (uid `uid`) outside what goes with it — its account
 * node, its home, which may hold directories and nothing else, and its own group — as phrases for
 * an error; none when nothing does. A node it owns, made, last changed or last modified, or whose
 * ACL names it; a node of its own group's; its writes in the audit trail; its records in the access
 * log; a share link that shows things as it. Each would point at its uid once it is gone, and at
 * whoever is given that uid next.
 */
export const stillNamed = async (cmd: Command, username: string, uid: number): Promise<string[]> => {
  const { vfs } = cmd.sys;
  const reasons: string[] = [];
  const home = join(cmd.env.HOMES_PATH, username);
  const userPath = join(cmd.env.USERS_PATH, username);
  const groupPath = join(cmd.env.GROUPS_PATH, username);
  const ownGroup = (await vfs.get<GroupAttrs>(ADMIN_ACCESS, groupPath).catch(() => undefined))?.attrs.gid === uid;
  const paths = [userPath, home, ...(ownGroup ? [groupPath] : [])];

  const homeIds = await treeIds(vfs, home, true);
  if (homeIds === null) reasons.push('its home holds more than directories');
  const own = [...homeIds ?? [], ...(await treeIds(vfs, userPath, false))!, ...(ownGroup ? (await treeIds(vfs, groupPath, false))! : [])];

  const named = await vfs.countNamed(ADMIN_ACCESS, { kind: 'uid', id: uid }, own);
  if (named.owned) reasons.push(`it owns ${countOf(named.owned, 'node', 'nodes')}`);
  if (named.born) reasons.push(`it made ${countOf(named.born, 'node', 'nodes')}`);
  if (named.changed) reasons.push(`it last changed ${countOf(named.changed, 'node', 'nodes')}`);
  if (named.modified) reasons.push(`it last modified ${countOf(named.modified, 'node', 'nodes')}`);
  if (named.acl) reasons.push(`${countOf(named.acl, 'ACL names', 'ACLs name')} it`);
  if (ownGroup) {
    const group = await vfs.countNamed(ADMIN_ACCESS, { kind: 'gid', id: uid }, own);
    if (group.owned) reasons.push(`its group owns ${countOf(group.owned, 'node', 'nodes')}`);
    if (group.acl) reasons.push(`${countOf(group.acl, 'ACL names', 'ACLs name')} its group`);
  }

  // Its writes to its own nodes do not count, but only as many as are read: past that, it did enough.
  const trail = await vfs.audit(ADMIN_ACCESS, { uid, limit: RECORDS });
  const writes = trail.filter((record) => !paths.some((path) => isPathWithin(record.path, path)));
  if (trail.length === RECORDS) reasons.push(`${RECORDS} or more writes of its in the audit trail`);
  else if (writes.length > 0) reasons.push(`${countOf(writes.length, 'write', 'writes')} of its in the audit trail`);
  const logged = await vfs.accessLog(ADMIN_ACCESS, { uid, limit: RECORDS });
  if (logged.length > 0) reasons.push(`${countOf(logged.length, 'record', 'records')} of its in the access log`);
  const links = (await vfs.children(ADMIN_ACCESS, cmd.env.LINKS_PATH).catch(() => [])).filter((entry) => entry.node.attrs.as === uid);
  if (links.length > 0) reasons.push(`${countOf(links.length, 'share link shows', 'share links show')} things as it`);
  return reasons;
};
