import type { GroupId, UserId } from './ids.ts';
import type { GroupRole } from './users.ts';

export type ShareInfo = {
  path: string;
  type: string;
  /** What a page calls the node: its title, its name, or the last part of its path. */
  title: string;
  /** `personPath`: the person the account is, whose picture stands for it, as for `users`. */
  owner: { uid: UserId; username?: string; title?: string; path?: string; personPath?: string; level: ShareLevel };
  /** The node's own group, whether or not a group node still carries that gid. */
  group: { gid: GroupId; groupname?: string };
  mode: number;
  /**
   * Whether the caller may change any of this. Answered here with the real
   * `verifyAccess` rather than re-derived in the browser, so an access-list
   * grant — which the client-side `canWrite` cannot see — still opens the
   * dialog for editing.
   */
  canEdit: boolean;
  preset: SharePreset;
  everyone: ShareLevel;
  pinned: boolean;
  grants: ShareGrant[];
  /**
   * The system default, resolved against the node's owner, and whether this node is
   * already on it. Sent with the rest so the dialog can offer "Default" without
   * a second round trip.
   */
  default: { mode: number; uid: UserId; gid: GroupId; ownerName?: string; groupName?: string; active: boolean };
  effective: EffectiveEntry[];
  /**
   * Every group and active user, so the dialog can offer what is not listed yet; empty for a caller who may not change it.
   * A user's `personPath` is the person the account is, from its `person` link, whose picture stands for it.
   */
  groups: { groupname: string; gid: GroupId; title?: string; members: number; role?: GroupRole }[];
  users: { username: string; uid: UserId; title?: string; path: string; personPath?: string; gids?: GroupId[]; admin?: boolean }[];
  /**
   * Whether visitors who have not signed in browse the archive (`CFG_GUEST_BROWSING`): then
   * "everyone" reaches them too, and the dialog has to say so.
   */
  guestBrowsing: boolean;
  /** The share links that open this node; their tokens only for a caller who may change it. */
  links: ShareLink[];
  /**
   * Nodes below this one that keep their own sharing (`share-set --pin`), so a change made here
   * does not reach them — the first `EXCEPTIONS_SHOWN` the caller can read, of `exceptionCount`.
   */
  exceptions: ShareException[];
  exceptionCount: number;
};

/** How many of a node's exceptions `share-info` lists. */
export const EXCEPTIONS_SHOWN = 50;

/** A node below the one asked about that keeps its own sharing. */
export type ShareException = {
  path: string;
  type: string;
  name: string;
  /** Its own sharing, in the dialog's three states. */
  preset: SharePreset;
};

/** A share link, as `share-link` and `share-info` answer about it. */
export type ShareLink = {
  id: string;
  /** The node it opens, where it is now. */
  path: string;
  /** What `/s/<token>` carries; given only to a caller who may change the node. */
  token?: string;
  createdBy: { uid: UserId; name?: string };
  createdAt: number;
  /** Epoch ms after which it opens nothing; absent when it does not expire. */
  expiresAt?: number;
  /** How many times it was opened, and when last. */
  opened: number;
  lastOpenedAt?: number;
};

/** What `share-link create` answers: the new link, and how far through the node it reached. */
export type ShareLinkCreated = {
  link: ShareLink;
  /** Nodes the link opens, the named one included. */
  updated: number;
  /** Nodes left out with everything below them, because they keep their own sharing. */
  pinned: number;
  /** Nodes left out because the creator may not change them. */
  failed: number;
};

/** What `share-link open` answers: the node the link opens, for the page that shows it. */
export type ShareLinkOpened = {
  id: string;
  path: string;
  type: string;
  title: string;
  expiresAt?: number;
};

/** A link the session holds, as `user-whoami` lists it: what it opens. */
export type HeldShareLink = {
  id: string;
  path: string;
  type: string;
  title: string;
  expiresAt?: number;
};

/**
 * What one grantee may do, in the terms a sharing dialog talks in.
 *
 * The whole point is that `rwx` triples do not survive contact with an end
 * user: the three states below are the only ones a sharing UI ever needs, and
 * naming them here keeps the mapping to mode bits in one place instead of
 * spread over every caller that builds a mode.
 */
export type ShareLevel = 'none' | 'view' | 'edit';

/**
 * How wide a node's access is, in the three states a sharing dialog offers.
 *
 * Derived from the bits rather than stored: there is no fourth source of truth
 * to keep in step, and a node changed from the shell reports the same preset
 * the dialog would have set.
 */
export type SharePreset = 'private' | 'shared' | 'everyone';

/** One person's standing with a node, and what grants it. */
export type EffectiveEntry = {
  /** User node carrying the person's optional cover photo. */
  path: string;
  username: string;
  title?: string;
  level: ShareLevel;
  /** Which rule granted it, in the order `verifyAccess` checks them. */
  via: 'admin' | 'owner' | 'group' | 'everyone' | 'direct';
  /** The group whose membership carried it, when `via` names one. */
  viaGroup?: string;
};

/** One editable row in the sharing dialog. */
export type ShareGrant = {
  kind: 'group' | 'user';
  /** gid or uid — what `share-set` names the grantee by. */
  id: GroupId | UserId;
  name: string;
  title?: string;
  /** User node carrying the grantee's optional cover photo. */
  path?: string;
  /** Users only: the person the account is, whose picture stands for it before the user node's. */
  personPath?: string;
  level: ShareLevel;
  /**
   * `primary` is the node's own group, written through the mode bits; `acl` is
   * an entry in the access control list. The dialog has to keep them apart
   * because only one node can have a primary group.
   */
  source: 'primary' | 'acl';
  /** Groups only: how many people the grant reaches. */
  members?: number;
  /** Groups only: which group made at boot it is — `everyone` is every signed-in person's. */
  role?: GroupRole;
};

/** What one `share-set` did, over every path it was given. */
export type ShareSetResult = {
  ok: true;
  /** Nodes written, the named ones included. */
  updated: number;
  /** Nodes left alone, with everything below them, because they keep their own sharing (`--pin`). */
  pinned: number;
  /** Nodes not descended into because something else is mounted there. */
  skipped: number;
  /** Nodes that could not be written, a named one included. */
  failed: number;
  /** The first of those refusals, each with its reason. */
  failures: { path: string; message: string }[];
};

/** One node a caller is judged differently for by its stored reach and by walking its paths. */
export type ReachMismatch = { id: string; path: string; uid: UserId; byReach: boolean; byPath: boolean };

/**
 * `reach-check`: a sample of nodes, each judged for every account and share link both by stored
 * reach and by walking its paths, and the ids reach names that no account, link or group holds.
 */
export type ReachCheck = {
  sampled: number;
  callers: number;
  mismatches: ReachMismatch[];
  unknown: { uids: UserId[]; gids: GroupId[] };
};
