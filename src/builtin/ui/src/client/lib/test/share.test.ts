import { assertEquals } from '@std/assert';
import {
  buildFollowAllCommand,
  buildReferenceCommand,
  buildShareCommand,
  defaultDraft,
  draftVisibility,
  everyoneLevel,
  grantKey,
  groupLevel,
  listedGrants,
  openingDraft,
  ownershipVisibility,
  privateDraft,
  visitorsSee,
  withEveryoneLevel,
  withGrant,
  withGroupLevel,
  withoutGrant,
  withVisitors,
} from '../share.ts';
import type { ShareDraft, ShareGrant } from '../share.ts';

const group = (level: ShareGrant['level'], source: ShareGrant['source'] = 'acl'): ShareGrant => ({
  kind: 'group',
  id: 1002,
  name: 'family',
  source,
  level,
});

const draft = (mode: number, grants: ShareGrant[] = []): ShareDraft => ({ mode, grants });

Deno.test('levels read the three classes of mode bits apart', () => {
  assertEquals(groupLevel(0o750), 'view');
  assertEquals(everyoneLevel(0o750), 'none');
  assertEquals(everyoneLevel(0o755), 'view');
  assertEquals(groupLevel(0o770), 'edit');
});

Deno.test('a view grant carries execute, or the node cannot be traversed', () => {
  assertEquals(withGroupLevel(0o700, 'view') & 0o070, 0o050);
  assertEquals(withGroupLevel(0o700, 'edit') & 0o070, 0o070);
  assertEquals(withGroupLevel(0o770, 'none') & 0o070, 0);
});

Deno.test('setting one class leaves the other two alone', () => {
  assertEquals(withEveryoneLevel(0o750, 'view'), 0o755);
  assertEquals(withGroupLevel(0o755, 'none'), 0o705);
});

Deno.test("removing the node's own group leaves it in the draft with no access; an entry goes", () => {
  const start = draft(0o750, [group('view', 'primary'), { kind: 'user', id: 42, name: 'anna', source: 'acl', level: 'edit' }]);

  const noGroup = withoutGrant(start, grantKey(group('view', 'primary')));
  assertEquals(noGroup.grants.map((grant) => [grant.name, grant.level]), [['family', 'none'], ['anna', 'edit']]);
  assertEquals(listedGrants(noGroup).map((grant) => grant.name), ['anna']);

  const noAnna = withoutGrant(start, 'user:acl:42');
  assertEquals(noAnna.grants.map((grant) => grant.name), ['family']);
});

Deno.test("adding the node's own group back gives it its bits rather than an entry", () => {
  const removed = draft(0o700, [group('none', 'primary')]);
  const back = withGrant(removed, { kind: 'group', id: 1002, name: 'family', level: 'view' });
  assertEquals(back.grants, [group('view', 'primary')]);

  const other = withGrant(removed, { kind: 'group', id: 1003, name: 'friends', level: 'view' });
  assertEquals(other.grants.map(grantKey), ['group:primary:1002', 'group:acl:1003']);
  // Added again, the entry is replaced, not repeated.
  assertEquals(withGrant(other, { kind: 'group', id: 1003, name: 'friends', level: 'edit' }).grants.at(-1)?.level, 'edit');
});

Deno.test("visitors see it through a grant to the guest's group, only ever to view, and are not a listed row", () => {
  assertEquals(visitorsSee(draft(0o750)), false);
  const open = withVisitors(draft(0o750), true);
  assertEquals([visitorsSee(open), open.mode, listedGrants(open)], [true, 0o750, []]);
  assertEquals(buildShareCommand('/a', open), "share-set '/a' --mode 0700 -b -m 'g:guest:rx'");
  assertEquals(visitorsSee(withVisitors(open, false)), false);
});

Deno.test('a saved draft becomes one share-set that replaces the whole list', () => {
  const command = buildShareCommand(`/archive/albums/x`, {
    mode: 0o700,
    grants: [
      group('view', 'primary'),
      { kind: 'group', id: 1003, name: 'friends', source: 'acl', level: 'view' },
      { kind: 'user', id: 42, name: 'anna', source: 'acl', level: 'edit' },
      // Dropped to no access: it must not survive as an entry.
      { kind: 'user', id: 43, name: 'eve', source: 'acl', level: 'none' },
    ],
  });

  assertEquals(
    command,
    `share-set '/archive/albums/x' --mode 0750 -b -m 'g:friends:rx' -m 'u:anna:rwx'`,
  );
});

Deno.test('grants are identified by grantee and source together', () => {
  // A node's own group can also carry an access-list entry, and the two rows
  // write to different locations — mode bits versus the list.
  const both: ShareGrant[] = [group('view', 'primary'), group('edit', 'acl')];

  const command = buildShareCommand('/x', draft(0o700, both));
  assertEquals(command, "share-set '/x' --mode 0750 -b -m 'g:family:rwx'");
});

Deno.test('the presets replace the rows: every account reads it, or the owner alone', () => {
  const users = { gid: 1002, groupname: 'users', title: 'Users', members: 5, role: 'everyone' as const };
  const family: ShareGrant = { kind: 'group', id: 2000, name: 'family', source: 'primary', level: 'edit' };
  const anna: ShareGrant = { kind: 'user', id: 42, name: 'anna', source: 'acl', level: 'view' };
  const start = draft(0o775, [family, anna]);

  assertEquals(buildShareCommand('/x', privateDraft(start)), "share-set '/x' --mode 0700 -b");
  assertEquals(buildShareCommand('/x', defaultDraft(start, users)), "share-set '/x' --mode 0700 -b -m 'g:users:rx'");
  // Where Users is the node's own group, the default is written in its bits.
  const own = draft(0o700, [{ kind: 'group', id: 1002, name: 'users', source: 'primary', level: 'none' }]);
  assertEquals(buildShareCommand('/x', defaultDraft(own, users)), "share-set '/x' --mode 0750 -b");
});

Deno.test('a selection is saved in one share-set, kept apart from the album and its link', () => {
  const command = buildShareCommand(['/a/1.jpg', '/a/2.jpg'], draft(0o700, [group('none', 'primary')]), { pin: true, dropLinks: true });
  assertEquals(command, "share-set '/a/1.jpg' '/a/2.jpg' --mode 0700 -b --drop-links --pin");
  assertEquals(buildReferenceCommand(['/a/1.jpg'], '/a'), "share-set '/a/1.jpg' --reference '/a' --unpin");
});

Deno.test('every exception in an album is shared like it in one share-set, those not listed too', () => {
  assertEquals(buildFollowAllCommand('/a'), "share-set '/a' --pinned-below --reference '/a' --unpin");
});

Deno.test('visibility is public with a link, restricted short of every account, private for the owner alone', () => {
  const at = (mode: number, gid: number, acl?: { mode: number; uid?: number; gid?: number }[], guests = false) =>
    ownershipVisibility({ mode, uid: 1, gid, ...(acl ? { acl } : {}) }, guests);

  assertEquals(at(0o700, 1002), 'private');
  assertEquals(at(0o750, 1002), null);
  assertEquals(at(0o750, 2000), 'restricted');
  assertEquals(at(0o700, 2000, [{ gid: 1002, mode: 0o5 }]), null);
  assertEquals(at(0o700, 2000, [{ uid: 2, mode: 0o5 }]), 'restricted');
  // An entry naming a share link's principal, from `LINK_UID_BASE` up.
  assertEquals(at(0o700, 2000, [{ uid: 0x40000000, mode: 0o5 }]), 'public');
  // The other bits reach every account and no one else; visitors are the guest's group's grant.
  assertEquals(at(0o705, 2000), null);
  assertEquals(at(0o705, 2000, undefined, true), null);
  assertEquals(at(0o700, 2000, [{ gid: 1001, mode: 0o5 }], true), 'public');
  assertEquals(at(0o700, 2000, [{ gid: 1001, mode: 0o5 }]), 'restricted');

  const users: ShareGrant = { kind: 'group', id: 1002, name: 'users', source: 'acl', level: 'view' };
  const family: ShareGrant = { kind: 'group', id: 2000, name: 'family', source: 'primary', level: 'view' };
  assertEquals(draftVisibility(draft(0o700, [family]), false, false), 'restricted');
  assertEquals(draftVisibility(draft(0o700, [family, users]), false, false), null);
  assertEquals(draftVisibility(draft(0o700, [{ ...family, level: 'none' }]), false, false), 'private');
  assertEquals(draftVisibility(draft(0o700, [{ ...family, level: 'none' }]), true, false), 'public');
});

Deno.test("the other bits open as the Users group's grant and are saved there", () => {
  const groups = [{ groupname: 'users', gid: 1002, members: 3, role: 'everyone' as const }];
  const own = (gid: number, level: ShareGrant['level']): ShareGrant => ({ kind: 'group', id: gid, name: gid === 1002 ? 'users' : 'anna', source: 'primary', level });

  // Already the node's group: the other bits only go.
  const onUsers = openingDraft({ mode: 0o755, grants: [own(1002, 'view')], groups });
  assertEquals(buildShareCommand('/a', onUsers), "share-set '/a' --mode 0750 -b");

  // Another group: the accounts outside it keep what the other bits gave them, through the Users group.
  const onAnna = openingDraft({ mode: 0o755, grants: [own(1003, 'view')], groups });
  assertEquals(buildShareCommand('/a', onAnna), "share-set '/a' --mode 0750 -b -m 'g:users:rx'");

  // The higher of the two, where the Users group is granted less than the other bits give.
  const less = openingDraft({ mode: 0o757, grants: [own(1003, 'view'), { ...own(1002, 'view'), source: 'acl' }], groups });
  assertEquals(buildShareCommand('/a', less), "share-set '/a' --mode 0750 -b -m 'g:users:rwx'");
});
