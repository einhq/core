import { encodeHex } from '@std/encoding';
import { basename, join } from '@std/path';
import { type Access, ADMIN_ACCESS, GUEST_ACCESS, type HeldLink, LINK_UID_BASE, linkLive } from '../../../../../lib/access/mod.ts';
import type { HeldShareLink, ShareLink } from '../../../../../lib/api/share.ts';
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

/** What a token is made of: letters and digits only, so it is safe in a URL and is never read as a flag. */
const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** 22 characters of 62: 130 random bits. */
const TOKEN_LENGTH = 22;

const TOKEN_PATTERN = /^[A-Za-z0-9]{22}$/;

/** A fresh link token. */
export const newToken = (): string => {
  let token = '';
  while (token.length < TOKEN_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      // 248 is four times 62: a byte above it would make the first letters likelier than the rest.
      if (byte < 248 && token.length < TOKEN_LENGTH) token += TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length];
    }
  }
  return token;
};

/** Whether `token` could be one `newToken` made, before anything is looked up by it. */
export const isToken = (token: string): boolean => TOKEN_PATTERN.test(token);

/**
 * The id a token's link goes by: in sessions, and as its record's name.
 * Derived from the token so a record is found by it directly, but one-way, so neither the
 * entries anyone may read nor a listing of `/var/links` gives the token away.
 */
export const linkId = async (token: string): Promise<string> => encodeHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))).slice(0, 16);

/** Whether two tokens are the same, in time that does not depend on where they differ. */
export const sameToken = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

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

/** The access of someone who opened the link `id`: its principal, in no group. */
export const linkAccess = (id: string, link: ShareLinkAttrs): Access => ({ uid: link.uid, gid: link.uid, gids: [], link: heldLink(id, link) });

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

/** What a session holding the link carries for it: its id and when it stops granting. */
export const heldLink = (id: string, link: ShareLinkAttrs): HeldLink => link.expiresAt === undefined ? { id } : { id, expiresAt: link.expiresAt };

/** A creator's name as the dialog shows it, by uid: the user's title, else the user name. */
export const userNames = async (vfs: NodeVFS, usersPath: string): Promise<Map<number, string>> => {
  const users = await vfs.children<UserAttrs>(ADMIN_ACCESS, usersPath).catch(() => []);
  return new Map(users.filter((entry) => isUserNode(entry.node)).map((entry) => [entry.node.attrs.uid, entry.node.attrs.title ?? entry.name]));
};

/** A link as the commands answer about it, at `path`; its token only when `withToken`. */
export const describeLink = (id: string, link: ShareLinkAttrs, path: string, withToken: boolean, names: Map<number, string>): ShareLink => ({
  id,
  path,
  ...(withToken ? { token: link.token } : {}),
  createdBy: { uid: link.createdBy, ...(names.has(link.createdBy) ? { name: names.get(link.createdBy) } : {}) },
  createdAt: link.createdAt,
  ...(link.expiresAt !== undefined ? { expiresAt: link.expiresAt } : {}),
  opened: link.opened,
  ...(link.lastOpenedAt !== undefined ? { lastOpenedAt: link.lastOpenedAt } : {}),
});

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
