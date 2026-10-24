import type { GroupId, UserId } from '../api/ids.ts';
export type { GroupId, UserId } from '../api/ids.ts';

export type Mode = number;

export type ModeMask = {
  READ: number;
  WRITE: number;
  EXEC: number;
};

/**
 * One entry of a node's access list: whom it names and the bits it grants them, where the other
 * bits sit. It names a user — an account, or a share link's principal — or a group.
 */
export type ModeACL = {
  mode: Mode;
  uid?: UserId;
  gid?: GroupId;
};

export type ModeStringOptions = {
  acl?: boolean;
  owner?: boolean;
  group?: boolean;
  other?: boolean;
};

export type SimpleOwnership = {
  uid?: UserId;
  gid?: GroupId;
};

export type Ownership = {
  mode: Mode;
  uid: UserId;
  gid: GroupId;
  acl?: ModeACL[];
};

export type ChownLookup = {
  user(name: string): Promise<UserId | undefined>;
  group(name: string): Promise<GroupId | undefined>;
};
