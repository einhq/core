import { checkMode, MaskACL, MaskGroup, MaskOther, MaskOwner, Ownership } from '../mode/mod.ts';
import { ACCESS_PINNED_ATTR, ADMIN_UID, GUEST_ACCESS, GUEST_UID, isLinkUid } from './constants.ts';
import { Access, AccessLevel, HeldLink } from './types.ts';
import type { NodeOwnership } from '../api/ids.ts';

/**
 * Whether `access` is an administrator's: flagged as one for a call, elevated for a sign-in
 * (`user-elevate`), or the admin user itself. A signed-in admin's session carries the uid without
 * either flag, so the uid alone counts.
 */
export const isAdmin = (access: Access): boolean => access.admin === true || access.elevated === true || access.uid === ADMIN_UID;

/** A stored `link` value as the link it is, or undefined when it is not a well-formed one. */
const heldLink = (value: unknown): HeldLink | undefined => {
  const { id, expiresAt } = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  if (typeof id !== 'string' || id === '') return undefined;
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? { id, expiresAt } : { id };
};

/**
 * An access read back from where it was stored — a session's — as the identity it may hold: uid,
 * gid, gids, whether the sign-in was elevated, the share link it acts as and the ids it acts
 * under. `admin` is granted by code for the length of a call and is never part of what a session
 * holds, so it is left behind, and neither the guest nor a link is ever elevated. A link's
 * principal is in no group. Anything malformed — a link's uid without its link among it — reads as
 * the guest.
 */
export const storedAccess = (value: unknown): Access => {
  const { uid, gid, gids, elevated, sid, cause, link } = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const guest = (): Access => ({ ...GUEST_ACCESS, gids: [...GUEST_ACCESS.gids] });
  if (typeof uid !== 'number' || typeof gid !== 'number' || !Array.isArray(gids) || !gids.every((id) => typeof id === 'number')) return guest();
  const attribution = { ...(typeof sid === 'string' ? { sid } : {}), ...(typeof cause === 'string' ? { cause } : {}) };
  if (isLinkUid(uid)) {
    const held = heldLink(link);
    return held ? { uid, gid: uid, gids: [], link: held, ...attribution } : guest();
  }
  return {
    uid,
    gid,
    gids: [...gids],
    ...(elevated === true && uid !== GUEST_UID ? { elevated: true } : {}),
    ...attribution,
  };
};

/** Whether `access` is a share link's principal whose link has not expired at `now`. */
export const linkLive = (access: Access, now = Date.now()): boolean => access.link !== undefined && (access.link.expiresAt === undefined || access.link.expiresAt > now);

/** Whether `access` is the guest: whoever reaches the server without signing in or opening a share link. */
export const isGuest = (access: Access): boolean => access.uid === GUEST_UID && access.link === undefined;

/** Whether `access` is someone who has not signed in: the guest, or a share link's principal. */
export const isVisitor = (access: Access): boolean => access.uid === GUEST_UID || access.link !== undefined;

/**
 * @description Verify that the access has the required level for the ownership.
 *
 * Someone who has not signed in never writes, whatever the mode or access list says: the guest is
 * whoever reaches the server without signing in, so a grant to it, its own home included, would be
 * a grant to anyone, and a share link's principal is whoever has the link. A link's own entries
 * stop granting once it has expired; the other bits, which are the system's, it keeps.
 */
export const verifyAccess = (
  access: Access,
  ownership: Ownership,
  level: AccessLevel,
) => {
  if (isAdmin(access)) {
    return true;
  }

  if (level === 'w' && isVisitor(access)) {
    return false;
  }

  if (ownership.uid === access.uid && checkMode(ownership.mode, level, MaskOwner)) {
    return true;
  }

  if (access.gids.includes(ownership.gid) && checkMode(ownership.mode, level, MaskGroup)) {
    return true;
  }

  if (checkMode(ownership.mode, level, MaskOther)) {
    return true;
  }

  if (ownership.acl && ownership.acl.length > 0) {
    for (const ac of ownership.acl) {
      const validAcl = (ac.uid !== undefined && ac.uid === access.uid && (access.link === undefined || linkLive(access))) ||
        (ac.gid !== undefined && access.gids.includes(ac.gid));

      if (validAcl && checkMode(ac.mode, level, MaskACL)) {
        return true;
      }
    }
  }

  return false;
};

/** Who may change a node, as an answer carries it for a reader to judge: the access list only when it has entries. */
export const nodeOwnership = ({ props }: { props: Ownership }): NodeOwnership => ({
  mode: props.mode,
  uid: props.uid,
  gid: props.gid,
  ...(props.acl?.length ? { acl: props.acl } : {}),
});

/** True when the node holds its own access against changes made further up (`share-set --pin`). */
export const isPinned = (node: { attrs?: Record<string, unknown> }): boolean => node.attrs?.[ACCESS_PINNED_ATTR] === true;
