import { assertEquals } from '@std/assert';
import type { GroupEntry, SessionEntry, UserEntry } from '@ein/api';
import {
  accountOption,
  accountStatus,
  displayName,
  formatGroupList,
  humanDuration,
  isPersonalGroup,
  membershipOf,
  newUserGroups,
  parseGroupList,
  personalGroupOf,
  signedIn,
  sortGroups,
  sortUsers,
} from '../accounts.ts';

const user = (username: string, uid: number, extra: Partial<UserEntry> = {}): UserEntry => ({
  username,
  uid,
  gid: uid,
  inactive: false,
  mustResetPassword: false,
  hasPassword: true,
  ...extra,
});

const group = (groupname: string, gid: number, extra: Partial<GroupEntry> = {}): GroupEntry => ({ groupname, gid, ...extra });

const admin = user('admin', 0, { role: 'administrator', title: 'Administrator' });
const guest = user('guest', 1001, { role: 'guest', hasPassword: false });
const anna = user('anna', 1004, { title: 'Anna Andersson' });
const bo = user('bo', 1005, { title: 'Bo Berg' });

const adminGroup = group('admin', 0, { role: 'administrators' });
const guestGroup = group('guest', 1001, { role: 'guests' });
const users = group('users', 1002, { role: 'everyone', members: ['anna', 'guest'] });
const ssh = group('ssh', 1003, { role: 'ssh' });
const annaGroup = group('anna', 1004);
const family = group('family', 1010, { title: 'Family', members: ['anna'] });

const session = (uid: number, tty: string): SessionEntry => ({ tty, origin: 'web', uid, user: '', since: 0, activeAt: 0, cwd: '/' });

Deno.test('a disabled account is disabled before it needs a password', () => {
  assertEquals(accountStatus(user('cy', 1006, { inactive: true, mustResetPassword: true })), 'disabled');
  assertEquals(accountStatus(user('cy', 1006, { mustResetPassword: true })), 'needs-password');
  assertEquals(accountStatus(user('cy', 1006, { hasPassword: false })), 'needs-password');
  assertEquals(accountStatus(anna), 'active');
});

Deno.test('an unreported password does not count as a missing one', () => {
  assertEquals(accountStatus(user('cy', 1006, { hasPassword: undefined })), 'active');
});

Deno.test('the guest, which has no password by design, is not waiting for one', () => {
  assertEquals(accountStatus(guest), 'active');
  assertEquals(accountStatus({ ...guest, inactive: true }), 'disabled');
});

Deno.test('the display name is the title, or the name without one', () => {
  assertEquals(displayName(anna), 'Anna Andersson');
  assertEquals(displayName(user('cy', 1006, { title: '  ' })), 'cy');
  assertEquals(displayName(family), 'Family');
  assertEquals(displayName(ssh), 'ssh');
});

Deno.test('an option names the account or group, with its title beside when it has one', () => {
  assertEquals(accountOption(anna), { value: 'anna', label: 'Anna Andersson (anna)' });
  assertEquals(accountOption(family), { value: 'family', label: 'Family (family)' });
  assertEquals(accountOption(ssh), { value: 'ssh', label: 'ssh' });
});

Deno.test('everyone who signs in belongs to the everyone group, the guest does not', () => {
  assertEquals(membershipOf(bo, users), 'automatic');
  assertEquals(membershipOf(anna, users), 'automatic');
  // Linked into `users` at boot, which gives a guest session nothing.
  assertEquals(membershipOf(guest, users), 'none');
});

Deno.test('the primary group counts with or without a link, before a link', () => {
  assertEquals(membershipOf(anna, annaGroup), 'primary');
  assertEquals(membershipOf({ ...bo, gid: 1010 }, family), 'primary');
  assertEquals(membershipOf({ ...anna, gid: 1010 }, family), 'primary');
});

Deno.test('a link is a membership, and nothing else is', () => {
  assertEquals(membershipOf(anna, family), 'member');
  assertEquals(membershipOf(bo, family), 'none');
  assertEquals(membershipOf(bo, ssh), 'none');
});

Deno.test('a personal group is named and numbered as its account', () => {
  const all = [admin, guest, anna, bo];
  assertEquals(isPersonalGroup(annaGroup, all), true);
  assertEquals(isPersonalGroup(group('anna', 1099), all), false);
  assertEquals(isPersonalGroup(group('bo', 1004), all), false);
  assertEquals(isPersonalGroup(family, all), false);
  assertEquals(personalGroupOf(anna, [family, annaGroup]), annaGroup);
  assertEquals(personalGroupOf(bo, [family, annaGroup]), undefined);
});

Deno.test("a built-in group is nobody's own, although admin and guest match the rule", () => {
  const all = [admin, guest, anna];
  assertEquals(isPersonalGroup(adminGroup, all), false);
  assertEquals(isPersonalGroup(guestGroup, all), false);
  assertEquals(personalGroupOf(admin, [adminGroup]), undefined);
  assertEquals(personalGroupOf(guest, [guestGroup]), undefined);
});

Deno.test('accounts sort by display name, the administrator first and the guest last', () => {
  const cy = user('cy', 1006);
  const sorted = sortUsers([guest, cy, bo, admin, anna]);
  assertEquals(sorted.map((entry) => entry.username), ['admin', 'anna', 'bo', 'cy', 'guest']);
});

Deno.test('sorting leaves the list it was given alone', () => {
  const list = [bo, anna];
  sortUsers(list);
  sortGroups([family, users]);
  assertEquals(list, [bo, anna]);
});

Deno.test('built-in groups come first in their own order, the rest by display name', () => {
  const kids = group('kids', 1011, { title: 'Children' });
  const sorted = sortGroups([family, guestGroup, kids, ssh, annaGroup, users, adminGroup]);
  assertEquals(sorted.map((entry) => entry.groupname), ['admin', 'users', 'ssh', 'guest', 'anna', 'kids', 'family']);
});

Deno.test('an account is signed in where a session carries its uid', () => {
  const sessions = [session(1004, 'web-1'), session(1005, 'ssh-1'), session(1004, 'term-2')];
  assertEquals(signedIn(anna, sessions).map((entry) => entry.tty), ['web-1', 'term-2']);
  assertEquals(signedIn(user('cy', 1006), sessions), []);
});

Deno.test('a new account gets the picked groups, then the defaults the form did not offer', () => {
  assertEquals(newUserGroups(['users', 'family'], ['family', 'kids'], ['kids']), ['kids', 'users']);
  assertEquals(newUserGroups(['users'], ['family'], ['family', 'family']), ['family', 'users']);
  assertEquals(newUserGroups(['family'], ['family'], ['family']), ['family']);
  assertEquals(newUserGroups([], [], []), []);
});

Deno.test('a group list reads commas and spaces and writes commas', () => {
  assertEquals(parseGroupList('users, family ,,kids,users'), ['users', 'family', 'kids']);
  assertEquals(parseGroupList(''), []);
  assertEquals(formatGroupList(['users', 'family']), 'users,family');
  assertEquals(formatGroupList([]), '');
});

Deno.test('a duration is said in the units it is whole in', () => {
  assertEquals(humanDuration(86400), '1 day');
  assertEquals(humanDuration(43200), '12 hours');
  assertEquals(humanDuration(194400), '2 days 6 hours');
  assertEquals(humanDuration(300), '5 minutes');
  assertEquals(humanDuration(1), '1 second');
  assertEquals(humanDuration(0), '0 seconds');
});

Deno.test('one of a unit with something over is said in the unit below', () => {
  assertEquals(humanDuration(90), '90 seconds');
  assertEquals(humanDuration(5400), '90 minutes');
  assertEquals(humanDuration(129600), '36 hours');
  assertEquals(humanDuration(3700), '61 minutes 40 seconds');
});

Deno.test('a duration keeps every part, so it stays exact', () => {
  assertEquals(humanDuration(2 * 86400 + 3600 + 1), '2 days 1 hour 1 second');
});

Deno.test('what is not a duration has no words', () => {
  assertEquals(humanDuration(-5), '');
  assertEquals(humanDuration(Number.NaN), '');
});
