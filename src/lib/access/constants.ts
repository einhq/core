import { Access } from './types.ts';

export const ADMIN_USERNAME = 'admin';
export const ADMIN_GROUPNAME = 'admin';
export const ADMIN_UID = 0;
export const ADMIN_GID = 0;

export const GUEST_USERNAME = 'guest';
export const GUEST_GROUPNAME = 'guest';
export const GUEST_UID = 1001;
export const GUEST_GID = 1001;

export const USERS_GROUPNAME = 'users';
export const USERS_GID = 1002;

/**
 * Where share links' principals take their uids: each link is a uid of its own from here up, past
 * any number an account or group is given, so neither is ever handed one of the other's.
 */
export const LINK_UID_BASE = 0x40000000;

/** Whether `uid` is a share link's principal rather than an account. */
export const isLinkUid = (uid: number | undefined): boolean => uid !== undefined && uid >= LINK_UID_BASE;

/**
 * Members may use `ssh`, `scp` and `ssh-copy-id`, which open connections from
 * this host to any machine it can reach. Created by name at boot, so its gid is
 * whatever was free then; resolve it rather than assuming one.
 */
export const SSH_GROUPNAME = 'ssh';

/**
 * Members may make a sign-in of theirs an administrator's by entering their password again
 * (`user-elevate`). Created by name at boot, like `ssh`.
 */
export const SUDO_GROUPNAME = 'sudo';

/**
 * The mode a node created in a parent with `parentMode` gets when its creator names none.
 *
 * Its owner gets everything and its group (the parent's group, see `LocalNodeVFS.createChildren`)
 * may read and pass through. The group may also write where it could write the parent, so a
 * folder a group shares keeps what is added to it writable for the group, while the system tree
 * under the `0755` root stays `0755`, as Linux's is.
 *
 * Others — a signed-in person outside the group, or the guest — can read and pass through a new
 * node only as far as they could its parent: a folder shared with everyone shows what is added to
 * it later, the way a Linux default ACL carries a grant down, and everything else stays closed.
 * Others' write is never inherited.
 */
export const modeUnder = (parentMode: number): number => 0o750 | (parentMode & 0o025);

export const ADMIN_ACCESS: Access = {
  uid: ADMIN_UID,
  gid: ADMIN_GID,
  gids: [ADMIN_GID],
  admin: true,
};

export const GUEST_ACCESS: Access = {
  uid: GUEST_UID,
  gid: GUEST_GID,
  gids: [GUEST_GID],
};

/**
 * Node attr that holds a node's access against a recursive change made further
 * up the tree. A recursive apply always writes the node it was aimed at, but
 * skips a pinned node and everything below it — which is what lets one photo
 * stay private inside an album that is otherwise shared.
 */
export const ACCESS_PINNED_ATTR = 'accessPinned';
