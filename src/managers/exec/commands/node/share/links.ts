import { encodeHex } from '@std/encoding';
import { basename, join } from '@std/path';
import { type Access, ADMIN_ACCESS, ADMIN_UID, GUEST_ACCESS, type HeldLink, LINK_UID_BASE, linkLive } from '../../../../../lib/access/mod.ts';
import type { HeldShareLink, ShareLink } from '../../../../../lib/api/share.ts';
import { accountOfUid, displayAccess, displayRefusal } from '../../../../../lib/auth/display-account.ts';
import type { Node, NodeChildEntry, NodeVFS } from '../../../../../vfs/mod.ts';
import { NODE_TYPE_SESSION, type SessionAttrs } from '../../../../../vfs/types/session.ts';
import { isShareLinkNode, type ShareLinkAttrs } from '../../../../../vfs/types/share-link.ts';
import { isUserNode, type UserAttrs } from '../../../../../vfs/types/user.ts';
import { updateHeldLinks } from '../../../../shell/shell.ts';
import type { Command } from '../../../command.ts';

/** What a link's access-list entry grants: read and pass through; its principal never writes anyway. */
export const LINK_MODE = 0o5;

/** How long a new link opens what it opens, unless it is given another expiry or none. */
export const DEFAULT_LINK_DAYS = 30;

/**
 * The id a token's link goes by: in sessions, and as its record's name.
 * Derived from the token so a record is found by it directly, but one-way, so neither the
 * entries anyone may read nor a listing of `/var/links` gives the token away.
 */
export const linkId = async (token: string): Promise<string> => encodeHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))).slice(0, 16);

/** A link's record by its id, read as the administrator; undefined when there is none. */
export const readLink = async (cmd: Command, id: string): Promise<Node<ShareLinkAttrs> | undefined> => {
  if (!/^[0-9a-f]{16}$/.test(id)) return undefined;
  const node = await cmd.sys.vfs.get<ShareLinkAttrs>(ADMIN_ACCESS, join(cmd.env.LINKS_PATH, id)).catch(() => undefined);
  return node && isShareLinkNode(node) ? node : undefined;
};

/** Every link's record. */
export const allLinks = async (cmd: Command): Promise<NodeChildEntry<ShareLinkAttrs>[]> =>
  (await cmd.sys.vfs.children<ShareLinkAttrs>(ADMIN_ACCESS, cmd.env.LINKS_PATH).catch(() => [])).filter((entry) => isShareLinkNode(entry.node));

/** A uid for a new link: past every link's, from `LINK_UID_BASE` up. */
export const newLinkUid = async (cmd: Command): Promise<number> =>
  (await allLinks(cmd)).reduce((highest, entry) => Math.max(highest, entry.node.attrs.uid), LINK_UID_BASE - 1) + 1;

/**
 * The access of someone who opened the link `id`: its principal, in no group, or for a link that
 * shows things as an account (`as`), that account's uid and groups beside the link's own uid.
 * Undefined when the account is gone or a link may no longer show things as it.
 */
export const linkAccess = async (vfs: NodeVFS, id: string, link: ShareLinkAttrs): Promise<Access | undefined> => {
  if (link.as === undefined) return { uid: link.uid, gid: link.uid, gids: [], link: heldLink(id, link) };
  const account = await displayAccess(vfs, link.as);
  return account && { uid: account.uid, gid: account.gid, gids: account.gids, link: heldLink(id, link) };
};

/** The guest's access, for a session or shell whose link was turned off. */
const guestAccess = (): Access => ({ ...GUEST_ACCESS, gids: [...GUEST_ACCESS.gids] });

/** Where the node a link opens is now: its first path outside a trash, or undefined when it is gone. */
export const targetPath = async (cmd: Command, link: ShareLinkAttrs): Promise<string | undefined> =>
  (await cmd.sys.vfs.resolveIdPaths(ADMIN_ACCESS, [link.target])).get(link.target)?.[0];

/** A node's title as a page would show it: its own, its name, else the last part of its path. */
export const titleOf = (node: Node, path: string): string => {
  const { title, name } = node.attrs as { title?: unknown; name?: unknown };
  return typeof title === 'string' && title ? title : typeof name === 'string' && name ? name : basename(path);
};

/** The link the caller acts as, while it still opens something, and what it opens; empty for anyone else. */
export const heldShareLinks = async (cmd: Command): Promise<HeldShareLink[]> => {
  const id = cmd.access.link?.id;
  if (!id || !linkLive(cmd.access)) return [];
  const record = await readLink(cmd, id);
  if (!record || isExpired(record.attrs)) return [];
  const path = await targetPath(cmd, record.attrs);
  const node = path ? await cmd.sys.vfs.get(ADMIN_ACCESS, path).catch(() => undefined) : undefined;
  if (!path || !node) return [];
  return [{
    id,
    path,
    type: node.type,
    title: titleOf(node, path),
    ...(record.attrs.expiresAt !== undefined ? { expiresAt: record.attrs.expiresAt } : {}),
  }];
};

/** Whether a link's time is up at `now`. */
export const isExpired = (link: ShareLinkAttrs, now = Date.now()): boolean => link.expiresAt !== undefined && link.expiresAt <= now;

/** What a session holding the link carries for it: its id, its own uid, and when it stops granting. */
export const heldLink = (id: string, link: ShareLinkAttrs): HeldLink => ({
  id,
  uid: link.uid,
  ...(link.expiresAt !== undefined ? { expiresAt: link.expiresAt } : {}),
});

/** A creator's name as the dialog shows it, by uid: the user's title, else the user name. */
export const userNames = async (vfs: NodeVFS, usersPath: string): Promise<Map<number, string>> => {
  const users = await vfs.children<UserAttrs>(ADMIN_ACCESS, usersPath).catch(() => []);
  return new Map(users.filter((entry) => isUserNode(entry.node)).map((entry) => [entry.node.attrs.uid, entry.node.attrs.title ?? entry.name]));
};

/** A link as the commands answer about it, at `path`; its token only when `withToken`. */
export const describeLink = async (
  vfs: NodeVFS,
  id: string,
  link: ShareLinkAttrs,
  path: string,
  withToken: boolean,
  names: Map<number, string>,
): Promise<ShareLink> => ({
  id,
  path,
  ...(withToken ? { token: link.token } : {}),
  createdBy: { uid: link.createdBy, ...(names.has(link.createdBy) ? { name: names.get(link.createdBy) } : {}) },
  createdAt: link.createdAt,
  ...(link.expiresAt !== undefined ? { expiresAt: link.expiresAt } : {}),
  opened: link.opened,
  ...(link.lastOpenedAt !== undefined ? { lastOpenedAt: link.lastOpenedAt } : {}),
  ...(link.as !== undefined ? { as: await shownAs(vfs, link.as, names) } : {}),
});

/** The account a link shows things as, by name, and why it no longer may when it may not. */
const shownAs = async (vfs: NodeVFS, uid: number, names: Map<number, string>): Promise<NonNullable<ShareLink['as']>> => {
  const account = await accountOfUid(vfs, uid);
  const refusal = account ? await displayRefusal(vfs, account) : 'the account is gone';
  return { uid, ...(names.has(uid) ? { name: names.get(uid) } : {}), ...(refusal ? { refusal } : {}) };
};

/**
 * Change the link `id` wherever someone acts as it: `replacement`, a changed expiry, in its place,
 * or, without one, back to the guest — in every session node acting as it, and in every open shell,
 * which keeps the access it opened with.
 */
export const updateHeld = async (cmd: Command, id: string, replacement?: HeldLink): Promise<void> => {
  const sessions = await cmd.sys.vfs.children<SessionAttrs>(ADMIN_ACCESS, cmd.env.SESSIONS_PATH).catch(() => []);

  for (const entry of sessions) {
    if (entry.node.type !== NODE_TYPE_SESSION) continue;
    const access = entry.node.attrs.access;
    if (access?.link?.id !== id) continue;

    await cmd.sys.vfs.update<SessionAttrs>(ADMIN_ACCESS, join(cmd.env.SESSIONS_PATH, entry.name), {
      attrs: { access: replacement ? { ...access, link: replacement } : guestAccess() },
    }).catch(() => undefined);
  }

  await updateHeldLinks(id, replacement);
};

/**
 * Turn a link off: its uid off every node, its record gone, and every session and shell acting as
 * it the guest again. Answers how many access-list entries it took away.
 */
export const removeLink = async (cmd: Command, id: string, uid: number): Promise<number> => {
  const released = await cmd.sys.vfs.releaseOwner(ADMIN_ACCESS, { kind: 'uid', id: uid, to: ADMIN_UID });
  await cmd.sys.vfs.unlink(ADMIN_ACCESS, join(cmd.env.LINKS_PATH, id), cmd.env.LINKS_PATH);
  await updateHeld(cmd, id);
  return released.acl;
};

/** Turn off every link that shows things as the account `uid`, which is going: answers how many. */
export const removeLinksShownAs = async (cmd: Command, uid: number): Promise<number> => {
  let removed = 0;
  for (const entry of await allLinks(cmd)) {
    if (entry.node.attrs.as !== uid) continue;
    await removeLink(cmd, entry.name, entry.node.attrs.uid);
    removed++;
  }
  return removed;
};
