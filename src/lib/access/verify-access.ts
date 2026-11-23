import { checkMode, MaskACL, MaskGroup, MaskOther, MaskOwner, Ownership } from '../mode/mod.ts';
import { ACCESS_PINNED_ATTR, ADMIN_GID, ADMIN_UID, GUEST_ACCESS, GUEST_UID, isLinkUid } from './constants.ts';
import { Access, AccessLevel, HeldLink } from './types.ts';
import type { NodeOwnership } from '../api/ids.ts';

/**
 * Whether `access` is an administrator's: flagged as one for a call, elevated for a sign-in
 * (`user-elevate`), or the admin user itself. A signed-in admin's session carries the uid without
 * either flag, so the uid alone counts. Nothing acting through a share link is one.
 */
export const isAdmin = (access: Access): boolean => access.link === undefined && (access.admin === true || access.elevated === true || access.uid === ADMIN_UID);

/** A stored `link` value as the link it is, or undefined when it is not a well-formed one. */
const heldLink = (value: unknown): HeldLink | undefined => {
  const { id, uid, expiresAt, route } = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  if (typeof id !== 'string' || id === '') return undefined;
  return {
    id,
    ...(typeof uid === 'number' && isLinkUid(uid) ? { uid } : {}),
    ...(typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? { expiresAt } : {}),
    ...(typeof route === 'string' && route.startsWith('/') ? { route } : {}),
  };
};

/**
 * An access read back from where it was stored — a session's — as the identity it may hold: uid,
 * gid, gids, whether the sign-in was elevated, the share link it acts as and the ids it acts
 * under. `admin` is granted by code for the length of a call and is never part of what a session
 * holds, so it is left behind, and neither the guest nor a link is ever elevated. A link's
 * principal is in no group; an account a link shows things as keeps its groups and the link.
 * Anything malformed — a link's uid without its link among it, a link that is there but not
 * well-formed — reads as the guest, never as the account signed in.
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
  if (link !== undefined) {
    const held = heldLink(link);
    return held ? { uid, gid, gids: [...gids], link: held, ...attribution } : guest();
  }
  return {
    uid,
    gid,
    gids: [...gids],
    ...(elevated === true && uid !== GUEST_UID ? { elevated: true } : {}),
    ...attribution,
  };
};

/**
 * Whether `access` acts through a share link whose grants count at `now`: one that has not expired,
 * and that holds neither the administrator's uid nor its group, since a link never acts as the
 * administrator.
 */
export const linkLive = (access: Access, now = Date.now()): boolean =>
  access.link !== undefined && (access.link.expiresAt === undefined || access.link.expiresAt > now) && access.uid !== ADMIN_UID && !access.gids.includes(ADMIN_GID);

/** Whether `access` is the guest: whoever reaches the server without signing in or opening a share link. */
export const isGuest = (access: Access): boolean => access.uid === GUEST_UID && access.link === undefined;

/** Whether `access` is someone who has not signed in: the guest, or whoever acts through a share link. */
export const isVisitor = (access: Access): boolean => access.uid === GUEST_UID || access.link !== undefined;

/**
 * Whether `viewer` may see what `owner` runs — its command lines (`ps`), its sessions (`who`) — and
 * signal it. An administrator sees everyone's and a member their own account's. Visitors share a
 * uid, every guest the guest's and everyone holding one share link the link's, so what a visitor
 * runs is seen only from the session that runs it, and a visitor sees no member's, not even of the
 * account a link shows things as.
 */
export const seesRunsOf = (viewer: Access, owner: Access): boolean => {
  if (isAdmin(viewer)) return true;
  if (viewer.uid !== owner.uid) return false;
  if (!isVisitor(viewer) && !isVisitor(owner)) return true;
  return viewer.sid !== undefined && viewer.sid === owner.sid;
};

/**
 * @description Verify that the access has the required level for the ownership.
 *
 * Someone who has not signed in never writes, whatever the mode or access list says: the guest is
 * whoever reaches the server without signing in, so a grant to it, its own home included, would be
 * a grant to anyone, and a share link is whoever has the link. What a link grants — its own
 * entries, and the owner's, group's and entries' of the account it shows things as — stops once
 * it has expired, or when it holds the administrator's uid or group (`linkLive`); the other bits,
 * which are the system's, it keeps.
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

  const live = access.link === undefined || linkLive(access);

  if (live && ownership.uid === access.uid && checkMode(ownership.mode, level, MaskOwner)) {
    return true;
  }

  if (live && access.gids.includes(ownership.gid) && checkMode(ownership.mode, level, MaskGroup)) {
    return true;
  }

  if (checkMode(ownership.mode, level, MaskOther)) {
    return true;
  }

  if (live && ownership.acl && ownership.acl.length > 0) {
    for (const ac of ownership.acl) {
      const validAcl = (ac.uid !== undefined && (ac.uid === access.uid || ac.uid === access.link?.uid)) ||
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
