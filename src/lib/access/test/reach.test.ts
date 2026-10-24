import { assertEquals } from '@std/assert';
import { LINK_UID_BASE } from '../constants.ts';
import { normalizeReach, passes, REACH_EVERYONE, REACH_NOBODY, reachAdmits, reachAny, reachKey, reachNamed, reachThrough } from '../reach.ts';

Deno.test('passes: execute for others is anyone, and an account in the access list is written as owning', () => {
  assertEquals(passes({ mode: 0o755, uid: 5, gid: 6 }), ['*']);
  assertEquals(passes({ mode: 0o750, uid: 5, gid: 6 }), ['g:6', 'u:5']);
  assertEquals(passes({ mode: 0o640, uid: 5, gid: 6 }), []);
  assertEquals(passes({ mode: 0o700, uid: 5, gid: 6, acl: [{ uid: 7, mode: 1 }, { gid: 8, mode: 5 }, { uid: 9, mode: 4 }] }), ['g:8', 'u:5', 'u:7']);
  assertEquals(passes({ mode: 0o700, uid: 5, gid: 6, acl: [{ uid: LINK_UID_BASE + 3, mode: 1 }] }), [`a:${LINK_UID_BASE + 3}`, 'u:5']);
});

Deno.test('reachThrough: a directory open to anyone changes nothing, a closed one admits nobody', () => {
  const owner = reachThrough(REACH_EVERYONE, ['u:5']);
  assertEquals(owner, [[['u:5']]]);
  // 0755 and 0775 under the same parent are the same reach.
  assertEquals(reachThrough(owner, passes({ mode: 0o755, uid: 1, gid: 1 })), reachThrough(owner, passes({ mode: 0o775, uid: 1, gid: 1 })));
  assertEquals(reachThrough(owner, []), REACH_NOBODY);
});

Deno.test('normalizeReach: a set holding another is absorbed, and so is a term that admits no one new', () => {
  assertEquals(normalizeReach([[['u:5', 'g:6'], ['u:5']]]), [[['u:5']]]);
  assertEquals(normalizeReach([[['u:5'], ['g:6']], [['u:5']]]), [[['u:5']]]);
  assertEquals(normalizeReach([[['u:5'], []]]), REACH_NOBODY);
  assertEquals(normalizeReach([[['*'], ['u:5']]]), [[['u:5']]]);
  // Written in any order, the same formula has one key.
  assertEquals(reachKey(reachAny([[[['g:6']]], [[['u:5']]]])), reachKey(reachAny([[[['u:5']]], [[['g:6']]]])));
});

Deno.test('reachAdmits judges groups and a share link against the caller', () => {
  const formula = reachAny([[[['u:5'], ['g:6', 'u:5']]], [[[`a:${LINK_UID_BASE + 1}`]]]]);
  assertEquals(reachAdmits(formula, { uid: 5, gid: 5, gids: [5] }), true);
  assertEquals(reachAdmits(formula, { uid: 7, gid: 7, gids: [6] }), false);
  const link = { uid: LINK_UID_BASE + 1, gid: LINK_UID_BASE + 1, gids: [] };
  assertEquals(reachAdmits(formula, { ...link, link: { id: 'l' } }), true);
  assertEquals(reachAdmits(formula, { ...link, link: { id: 'l', expiresAt: 1 } }), false);
  assertEquals(reachNamed(formula), { uids: [5, LINK_UID_BASE + 1], gids: [] });
});
