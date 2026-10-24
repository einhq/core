import { assertEquals } from '@std/assert';
import { GUEST_ACCESS, GUEST_GID, GUEST_UID, LINK_UID_BASE } from '../constants.ts';
import { linkLive, storedAccess, verifyAccess } from '../verify-access.ts';

const own = { uid: GUEST_UID, gid: GUEST_GID, mode: 0o777 };

Deno.test('the guest reads and traverses what its mode grants, but never writes', () => {
  assertEquals(verifyAccess(GUEST_ACCESS, own, 'r'), true);
  assertEquals(verifyAccess(GUEST_ACCESS, own, 'x'), true);
  assertEquals(verifyAccess(GUEST_ACCESS, own, 'w'), false);
  assertEquals(verifyAccess(GUEST_ACCESS, { uid: 0, gid: 0, mode: 0o000, acl: [{ uid: GUEST_UID, mode: 0o7 }] }, 'w'), false);
});

Deno.test('anyone else signed in writes where the others bit allows it', () => {
  assertEquals(verifyAccess({ uid: 1003, gid: 1003, gids: [1003] }, { uid: 0, gid: 0, mode: 0o777 }, 'w'), true);
});

const LINK = LINK_UID_BASE + 1;
const album = { uid: 0, gid: 0, mode: 0o700, acl: [{ uid: LINK, mode: 0o7 }] };
const visitor = (expiresAt?: number) => ({ uid: LINK, gid: LINK, gids: [], link: { id: 'k1', ...(expiresAt !== undefined ? { expiresAt } : {}) } });

Deno.test("a link's principal reads and passes through what its entries grant, and never writes", () => {
  assertEquals(verifyAccess(visitor(), album, 'r'), true);
  assertEquals(verifyAccess(visitor(), album, 'x'), true);
  assertEquals(verifyAccess(visitor(), album, 'w'), false);
  assertEquals(verifyAccess(GUEST_ACCESS, album, 'r'), false);
  // The other bits are the system's, and it gets them like anyone; its write is refused there too.
  assertEquals(verifyAccess(visitor(), { uid: 0, gid: 0, mode: 0o757 }, 'r'), true);
  assertEquals(verifyAccess(visitor(), { uid: 0, gid: 0, mode: 0o757 }, 'w'), false);
});

Deno.test("a link's entries stop granting once it expires", () => {
  assertEquals(verifyAccess(visitor(Date.now() + 60_000), album, 'r'), true);
  assertEquals(verifyAccess(visitor(Date.now() - 1), album, 'r'), false);
  assertEquals(linkLive(visitor(1000), 999), true);
  assertEquals(linkLive(visitor(1000), 1000), false);
  assertEquals(linkLive(GUEST_ACCESS), false);
});

Deno.test("a stored access keeps the link a link's principal acts as, in no group, and nothing malformed", () => {
  assertEquals(storedAccess({ uid: LINK, gid: 5, gids: [1002], link: { id: 'k1', expiresAt: 5 } }), { uid: LINK, gid: LINK, gids: [], link: { id: 'k1', expiresAt: 5 } });
  assertEquals(storedAccess({ uid: LINK, gid: LINK, gids: [], link: { id: 'k1', expiresAt: 'soon' } }).link, { id: 'k1' });
  // A link's uid without its link, or a link on an account, is not a link's principal.
  assertEquals(storedAccess({ uid: LINK, gid: LINK, gids: [] }).uid, GUEST_UID);
  assertEquals('link' in storedAccess({ uid: 1003, gid: 1003, gids: [1003], link: { id: 'k1' } }), false);
});
