import { GroupId, UserId } from '../mode/mod.ts';

/**
 * The share link an access acts as, having opened it: the link's own uid, whose access-list
 * entries let it read and pass through what it opens, until `expiresAt` (epoch ms) when there is
 * one. A link that shows things as an account (`share-link create --as`) gives the access that
 * account's uid and groups as well; the link's own `uid` is then not the access's.
 */
export type HeldLink = {
  id: string;
  uid?: UserId;
  expiresAt?: number;
};

export type Access = {
  /** The session or pipeline run acting, recorded with every write it makes. */
  sid?: string;
  /** Id of the audit record of the write this access acts because of: what set a pipeline run off. */
  cause?: string;
  /**
   * Whom the nodes this access creates are recorded as created by, when that is not `uid`: a
   * pipeline step creates what it derives from a node in the name of the person who made that node
   * (ein/core#318). Only an administrator's access creates in someone else's name.
   */
  creator?: UserId;
  uid: UserId;
  gid: GroupId;
  gids: GroupId[];
  /** An administrator's for the length of a call, granted by code; a session never holds it. */
  admin?: boolean;
  /**
   * An administrator's for as long as the sign-in lasts: a member of the `sudo` group entered
   * their password again (`user-elevate`). A session holds it, until `user-elevate --off`, a
   * sign-in or sign-out, or leaving the group takes it away.
   */
  elevated?: boolean;
  /**
   * Set when the access acts through a share link: which link, and until when. The access is the
   * link's principal (`uid` is the link's), or the account the link shows things as. Either way it
   * has not signed in, and never writes.
   */
  link?: HeldLink;
};

/** What a run's writes are recorded as coming from besides its account: the run, its cause, and in whose name it creates. */
export type Attribution = Pick<Access, 'sid' | 'cause' | 'creator'>;

export type AccessLevel = 'r' | 'w' | 'x';
