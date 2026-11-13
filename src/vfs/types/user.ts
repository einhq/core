import { GroupId, UserId } from '../../lib/mode/mod.ts';
import { Node, NodeAttrs, NodeType } from '../node.ts';

/**
 * An account: the `user` node at `<USERS_PATH>/<username>`, which the administrator owns, so
 * every attr here is the administrator's to set. Its user's home is `<HOMES_PATH>/<username>`.
 */
export type UserAttrs = NodeAttrs & {
  uid: UserId;
  /** The primary group: what a session counts as its `gid`, and a membership without a link. */
  gid: GroupId;
  name?: string;
  /** An address that signs in as the account like its username does, lower case; no two accounts share one. */
  email?: string;
  description?: string;
  inactive?: boolean;
  /**
   * False takes the account out of the everyone group (`users`): its sessions, and links that show
   * things as it, carry no `USERS_GID` unless `users` is its primary group. Absent, it is in.
   */
  everyone?: boolean;
  /**
   * When true the user has no usable password (e.g. imported from the old
   * system) and cannot authenticate until one is set, by an administrator or
   * with a sign-in link (`user-invite`), which clears it. Every auth site checks
   * it through `loginRefusal`.
   */
  mustResetPassword?: boolean;
};

export const NODE_TYPE_USER: NodeType = 'user';

/**
 * Whether a node is an account: a `user` node with a numeric uid and primary gid. Sign-in, a
 * shell's name and home and the account commands go by these alone, so another node under the
 * users directory with a `uid` attr is nobody to them.
 */
export const isUserNode = (node: Node): node is Node<UserAttrs> => node.type === NODE_TYPE_USER && typeof node.attrs.uid === 'number' && typeof node.attrs.gid === 'number';

/** Message thrown / logged when a gated user tries to authenticate. */
const PASSWORD_RESET_REQUIRED = 'password reset required';

/** Shared reset gate: true when the user must reset their password before login. */
const requiresPasswordReset = (attrs: UserAttrs): boolean => attrs.mustResetPassword === true;

/** Message thrown / logged when a disabled (`user-disable`) user tries to authenticate. */
const ACCOUNT_DISABLED = 'account disabled';

/**
 * Why this account may not sign in by any means — password, SSH key, web — or
 * undefined when it may. Every auth site asks this; password sign-in asks only
 * once the password is right, so the reason tells no one else the account exists.
 */
export const loginRefusal = (attrs: UserAttrs): string | undefined => {
  if (attrs.inactive === true) return ACCOUNT_DISABLED;
  if (requiresPasswordReset(attrs)) return PASSWORD_RESET_REQUIRED;
  return undefined;
};

/**
 * A sign-in link an administrator made for an account (`user-invite`), its child `.invite`: mode
 * 0600 and the administrator's, like its `.password`. Whoever opens `/invite/<token>` before it
 * expires chooses the account's password, which spends it.
 */
export const NODE_TYPE_USER_INVITE: NodeType = 'user-invite';

export type UserInviteAttrs = NodeAttrs & {
  token: string;
  createdBy: UserId;
  createdAt: number;
  expiresAt: number;
};

/** Whether a node is an account's sign-in link: a `user-invite` node with its token and expiry. */
export const isUserInviteNode = (node: Node): node is Node<UserInviteAttrs> =>
  node.type === NODE_TYPE_USER_INVITE && typeof node.attrs.token === 'string' && typeof node.attrs.expiresAt === 'number';
