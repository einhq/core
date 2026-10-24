import {
  ADMIN_GID,
  ADMIN_GROUPNAME,
  ADMIN_UID,
  ADMIN_USERNAME,
  GUEST_GROUPNAME,
  GUEST_UID,
  GUEST_USERNAME,
  SSH_GROUPNAME,
  SUDO_GROUPNAME,
  USERS_GID,
  USERS_GROUPNAME,
} from '../access/constants.ts';
import type { GroupRole, UserRole } from '../api/users.ts';
import type { GroupId, UserId } from '../mode/types.ts';

/** Which of the accounts made at boot this is, by its name or its uid, or undefined for any other. */
export const userRole = (username: string, uid: UserId | undefined): UserRole | undefined => {
  if (uid === ADMIN_UID || username === ADMIN_USERNAME) return 'administrator';
  if (uid === GUEST_UID || username === GUEST_USERNAME) return 'guest';
  return undefined;
};

/**
 * Which of the groups made at boot this is, or undefined for any other: by its name, and `admin`
 * and `users` also by their fixed gids, 0 and `USERS_GID`.
 */
export const groupRole = (groupname: string, gid: GroupId | undefined): GroupRole | undefined => {
  if (gid === ADMIN_GID || groupname === ADMIN_GROUPNAME) return 'administrators';
  if (groupname === GUEST_GROUPNAME) return 'guests';
  if (gid === USERS_GID || groupname === USERS_GROUPNAME) return 'everyone';
  if (groupname === SSH_GROUPNAME) return 'ssh';
  if (groupname === SUDO_GROUPNAME) return 'sudo';
  return undefined;
};
