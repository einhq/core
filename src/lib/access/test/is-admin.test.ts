import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, ADMIN_GID, ADMIN_UID, GUEST_ACCESS } from '../constants.ts';
import { isAdmin, storedAccess } from '../verify-access.ts';

Deno.test('the admin flag or the admin uid each make an administrator', () => {
  assertEquals(isAdmin(ADMIN_ACCESS), true);
  assertEquals(isAdmin({ uid: ADMIN_UID, gid: ADMIN_GID, gids: [ADMIN_GID] }), true);
  assertEquals(isAdmin({ uid: 1001, gid: 1001, gids: [1001], admin: true }), true);
});

Deno.test('anyone else is not', () => {
  assertEquals(isAdmin(GUEST_ACCESS), false);
  assertEquals(isAdmin({ uid: 1001, gid: 1001, gids: [1001, ADMIN_GID] }), false);
});

Deno.test('a stored access keeps who it is and never the admin flag', () => {
  assertEquals(storedAccess({ uid: 3000, gid: 3000, gids: [3000, 1002], sid: 's1', admin: true }), { uid: 3000, gid: 3000, gids: [3000, 1002], sid: 's1' });
  assertEquals(isAdmin(storedAccess({ uid: 3000, gid: 3000, gids: [3000], admin: true })), false);
  assertEquals(isAdmin(storedAccess({ uid: ADMIN_UID, gid: ADMIN_GID, gids: [ADMIN_GID] })), true);
});

Deno.test('an elevated sign-in is an administrator, and its session keeps it, never the guest', () => {
  assertEquals(isAdmin({ uid: 3000, gid: 3000, gids: [3000], elevated: true }), true);
  assertEquals(storedAccess({ uid: 3000, gid: 3000, gids: [3000], elevated: true }), { uid: 3000, gid: 3000, gids: [3000], elevated: true });
  assertEquals(isAdmin(storedAccess({ uid: 3000, gid: 3000, gids: [3000], elevated: 'yes' })), false);
  assertEquals(isAdmin(storedAccess({ ...GUEST_ACCESS, elevated: true })), false);
});

Deno.test('a malformed stored access is the guest', () => {
  for (const value of [undefined, null, 'admin', { uid: '0', gid: 0, gids: [0] }, { uid: 0, gid: 0 }, { uid: 0, gid: 0, gids: ['0'] }]) {
    assertEquals(storedAccess(value), GUEST_ACCESS);
  }
});
