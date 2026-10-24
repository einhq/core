export type UserId = number;

export type GroupId = number;

/**
 * Client-side node write-access check for edit affordances. The server
 * enforces access on every command; this only decides what UI to show.
 */

export type NodeOwnership = {
  mode: number;
  uid: number;
  gid: number;
  /** The node's access list, when it has one: grants on top of the mode bits, to a user — a share link's among them — or a group. */
  acl?: { mode: number; uid?: number; gid?: number }[];
};

export type NodeId = string;

export type NodePath = string;

/**
 * A value as it arrives over JSON: a `Date` is its ISO string. For answer types whose server side
 * holds dates, so the declared answer is what a reader actually parses.
 */
export type Wire<T> = T extends Date ? string
  : T extends (infer U)[] ? Wire<U>[]
  : T extends object ? { [K in keyof T]: Wire<T[K]> }
  : T;
