/**
 * Invitations: a token that opens named nodes over a WebSocket, a stream to read or to write, a
 * socket to connect to,
 * to whoever holds it, from a page of any origin, until it expires or is turned off. Its record is
 * under `INVITATIONS_PATH`, named by its token's hash and holding only the hash, and readable by the
 * administrator alone. A node is opened with its creator's access as it is then, so an invitation
 * never reaches more than its creator does, and stops when the creator's account is gone or
 * disabled.
 */

import { encodeHex } from '@std/encoding';
import { join } from '@std/path';
import { ADMIN_ACCESS } from '../access/constants.ts';
import type { Access } from '../access/types.ts';
import type { InvitationNode } from '../api/invitation.ts';
import { accessOfUid } from '../auth/member-gids.ts';
import { INVITATIONS_PATH } from '../paths.ts';
import { isToken, sameToken } from '../token/mod.ts';
import type { NodeVFS } from '../../vfs/node-vfs.ts';
import type { Node } from '../../vfs/node.ts';
import { type InvitationAttrs, isInvitationNode } from '../../vfs/types/invitation.ts';

/** How long a new invitation opens its nodes, unless it is given another expiry. */
export const DEFAULT_INVITATION_HOURS = 24;

/** The longest an invitation may last: whoever holds it writes as its creator. */
export const MAX_INVITATION_DAYS = 90;

/** The most nodes one invitation opens. */
export const MAX_INVITATION_NODES = 16;

/** The SHA-256 of a token, in hex: all a record keeps of it. */
export const tokenHash = async (token: string): Promise<string> => encodeHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));

/** The id an invitation goes by, its record's name: the start of its token's hash. */
export const invitationId = (hash: string): string => hash.slice(0, 16);

/** Whether an invitation's time is up at `now`. */
export const isInvitationExpired = (attrs: InvitationAttrs, now = Date.now()): boolean => attrs.expiresAt <= now;

/** An invitation's record by its id, read as the administrator; undefined when there is none. */
export const readInvitation = async (vfs: NodeVFS, id: string): Promise<Node<InvitationAttrs> | undefined> => {
  if (!/^[0-9a-f]{16}$/.test(id)) return undefined;
  const node = await vfs.get<InvitationAttrs>(ADMIN_ACCESS, join(INVITATIONS_PATH, id)).catch(() => undefined);
  return node && isInvitationNode(node) ? node : undefined;
};

/** Every invitation's record, with its id. */
export const allInvitations = async (vfs: NodeVFS): Promise<{ id: string; node: Node<InvitationAttrs> }[]> =>
  (await vfs.children<InvitationAttrs>(ADMIN_ACCESS, INVITATIONS_PATH).catch(() => []))
    .filter((entry) => isInvitationNode(entry.node))
    .map((entry) => ({ id: entry.name, node: entry.node }));

/**
 * The invitation `token` names, while it opens anything: its record, and the access its nodes are
 * opened with. Undefined for a token that names none, an expired one, or one whose creator has no
 * active account any more; a caller tells none of these apart, so a guesser learns nothing.
 */
export const invitationByToken = async (
  vfs: NodeVFS,
  token: string,
  now = Date.now(),
): Promise<{ id: string; node: Node<InvitationAttrs>; access: Access } | undefined> => {
  if (!isToken(token)) return undefined;
  const hash = await tokenHash(token);
  const id = invitationId(hash);
  const node = await readInvitation(vfs, id);
  if (!node || !sameToken(node.attrs.hash, hash) || isInvitationExpired(node.attrs, now)) return undefined;
  const access = await accessOfUid(vfs, node.attrs.createdBy);
  return access && { id, node, access: { ...access, invitation: id } };
};

/** The nodes an invitation opens, where they are now; one removed since is left out. */
export const invitationNodes = async (vfs: NodeVFS, attrs: InvitationAttrs): Promise<InvitationNode[]> => {
  const paths = await vfs.resolveIdPaths(ADMIN_ACCESS, attrs.nodes.map((node) => node.id));
  return attrs.nodes.flatMap((node) => {
    const path = paths.get(node.id)?.[0];
    return path ? [{ path, mode: node.mode }] : [];
  });
};

/** Whether the invitation opens the node at `path` (any path it is at) to `mode`. */
export const invitationOpens = async (vfs: NodeVFS, attrs: InvitationAttrs, path: string, mode: string): Promise<boolean> => {
  const wanted = attrs.nodes.filter((node) => node.mode === mode);
  if (wanted.length === 0) return false;
  const paths = await vfs.resolveIdPaths(ADMIN_ACCESS, wanted.map((node) => node.id));
  return wanted.some((node) => paths.get(node.id)?.includes(path));
};

/** How each open socket of an invitation is ended, by its id. */
const openSockets = new Map<string, Set<(reason: string) => void>>();

/** Keep `end` as how a socket the invitation `id` opened is ended, until the answer is called. */
export const holdInvitationSocket = (id: string, end: (reason: string) => void): () => void => {
  const ends = openSockets.get(id) ?? new Set();
  ends.add(end);
  openSockets.set(id, ends);
  return () => {
    ends.delete(end);
    if (ends.size === 0 && openSockets.get(id) === ends) openSockets.delete(id);
  };
};

/** Turn an invitation off: its record gone, and every socket it opened closed. */
export const removeInvitation = async (vfs: NodeVFS, id: string, reason = 'the invitation was turned off'): Promise<void> => {
  await vfs.unlink(ADMIN_ACCESS, join(INVITATIONS_PATH, id), INVITATIONS_PATH);
  for (const end of [...openSockets.get(id) ?? []]) end(reason);
};

/** Count a socket the invitation `id` opened, and when: false when it was turned off meanwhile. */
export const markInvitationOpened = async (vfs: NodeVFS, id: string): Promise<boolean> => {
  const node = await readInvitation(vfs, id);
  if (!node) return false;
  await vfs.update<InvitationAttrs>(ADMIN_ACCESS, join(INVITATIONS_PATH, id), { attrs: { opened: node.attrs.opened + 1, lastOpenedAt: Date.now() } }).catch(() => undefined);
  return true;
};
