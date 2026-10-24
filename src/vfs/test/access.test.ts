/**
 * VFS access enforcement: mode bits for owner/group/other, chmod/chown
 * effects and admin bypass, exercised with non-admin Access fixtures.
 */

import { assertEquals, assertRejects } from '@std/assert';
import type { Access } from '../../lib/access/mod.ts';
import { ADMIN_ACCESS, GUEST_ACCESS, LINK_UID_BASE } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { NodeAccessDeniedError } from '../mod.ts';
import { UNLISTED_ATTR } from '../types/directory.ts';
import { mkdir, mkfile, readFile } from './helpers.ts';

const OWNER: Access = { uid: 5000, gid: 4000, gids: [4000] };
const GROUP_MATE: Access = { uid: 5001, gid: 4000, gids: [4000] };
const OTHER: Access = { uid: 6000, gid: 6000, gids: [6000] };

Deno.test('VFS access enforcement', async (t) => {
  const ctx = await createTestVfs();
  const { vfs } = ctx;

  try {
    // World-writable working area owned by OWNER
    await mkdir(vfs, ADMIN_ACCESS, '/', 'area', 0o777);
    await vfs.update(ADMIN_ACCESS, '/area', { props: { uid: OWNER.uid, gid: OWNER.gid } });

    await t.step('owner rw, group r, other none (0o640)', async () => {
      await mkfile(vfs, OWNER, '/area', 'secret.txt', 'classified', 0o640);

      assertEquals(await readFile(vfs, OWNER, '/area/secret.txt'), 'classified');
      assertEquals(await readFile(vfs, GROUP_MATE, '/area/secret.txt'), 'classified');
      await assertRejects(() => readFile(vfs, OTHER, '/area/secret.txt'), NodeAccessDeniedError);

      // Group may read but not write
      await assertRejects(async () => {
        const h = await vfs.open(GROUP_MATE, '/area/secret.txt', { mode: 'w' });
        await h.close();
      }, NodeAccessDeniedError);
    });

    await t.step('other can read 0o644 but not write', async () => {
      await mkfile(vfs, OWNER, '/area', 'public.txt', 'readable', 0o644);

      assertEquals(await readFile(vfs, OTHER, '/area/public.txt'), 'readable');
      await assertRejects(async () => {
        const h = await vfs.open(OTHER, '/area/public.txt', { mode: 'w' });
        await h.close();
      }, NodeAccessDeniedError);
    });

    await t.step('directory without x is not traversable', async () => {
      await mkdir(vfs, OWNER, '/area', 'noexec', 0o700);
      await mkfile(vfs, OWNER, '/area/noexec', 'inner.txt', 'hidden', 0o644);
      await vfs.update(OWNER, '/area/noexec', { props: { mode: 0o600 } });

      // Without x, even the owner cannot traverse into the directory
      await assertRejects(() => vfs.get(OWNER, '/area/noexec/inner.txt'), NodeAccessDeniedError);
      await assertRejects(() => vfs.get(OTHER, '/area/noexec/inner.txt'), NodeAccessDeniedError);
    });

    await t.step('directory without w rejects child creation', async () => {
      await mkdir(vfs, OWNER, '/area', 'readonly', 0o755);

      await assertRejects(() => mkfile(vfs, OTHER, '/area/readonly', 'nope.txt', 'x'), NodeAccessDeniedError);

      // Owner can create
      await mkfile(vfs, OWNER, '/area/readonly', 'ok.txt', 'fine');
    });

    await t.step("a new node takes its parent's access list along with its group", async () => {
      const grants = [{ uid: OTHER.uid, mode: 0o5 }, { uid: LINK_UID_BASE, mode: 0o5 }];
      await mkdir(vfs, OWNER, '/area', 'shared-album', 0o750);
      await vfs.update(OWNER, '/area/shared-album', { props: { acl: grants } });

      await mkfile(vfs, OWNER, '/area/shared-album', 'later.jpg', 'added after the album was shared', 0o640);
      assertEquals((await vfs.get(ADMIN_ACCESS, '/area/shared-album/later.jpg')).props.acl, grants);
      assertEquals(await readFile(vfs, OTHER, '/area/shared-album/later.jpg'), 'added after the album was shared');
      assertEquals(
        await readFile(vfs, { uid: LINK_UID_BASE, gid: LINK_UID_BASE, gids: [], link: { id: 'k1' } }, '/area/shared-album/later.jpg'),
        'added after the album was shared',
      );

      // A list the creator names is the list it gets.
      await vfs.create(OWNER, 'directory', '/area/shared-album', 'own', { props: { mode: 0o700, acl: [] } });
      assertEquals((await vfs.get(ADMIN_ACCESS, '/area/shared-album/own')).props.acl, []);
    });

    await t.step('chmod changes enforcement', async () => {
      await vfs.update(OWNER, '/area/secret.txt', { props: { mode: 0o644 } });
      assertEquals(await readFile(vfs, OTHER, '/area/secret.txt'), 'classified');

      await vfs.update(OWNER, '/area/secret.txt', { props: { mode: 0o600 } });
      await assertRejects(() => readFile(vfs, GROUP_MATE, '/area/secret.txt'), NodeAccessDeniedError);
    });

    await t.step('chown transfers ownership', async () => {
      await mkfile(vfs, OWNER, '/area', 'gift.txt', 'yours now', 0o600);
      await vfs.update(ADMIN_ACCESS, '/area/gift.txt', { props: { uid: OTHER.uid, gid: OTHER.gid } });

      assertEquals(await readFile(vfs, OTHER, '/area/gift.txt'), 'yours now');
      await assertRejects(() => readFile(vfs, GROUP_MATE, '/area/gift.txt'), NodeAccessDeniedError);
    });

    await t.step('only the administrator gives a node away; others move it only into their groups', async () => {
      const MEMBER: Access = { uid: 5002, gid: 4000, gids: [4000, 4100] };
      await mkfile(vfs, MEMBER, '/area', 'mine.txt', 'x', 0o660);

      // Write access is not enough to give it to someone else, or to take it.
      await assertRejects(() => vfs.update(MEMBER, '/area/mine.txt', { props: { uid: OTHER.uid } }), NodeAccessDeniedError);
      await assertRejects(() => vfs.update(GROUP_MATE, '/area/mine.txt', { props: { uid: GROUP_MATE.uid } }), NodeAccessDeniedError);
      await assertRejects(() => vfs.update(MEMBER, '/area/mine.txt', { props: { gid: OTHER.gid } }), NodeAccessDeniedError);

      // Into a group the caller is in, and restating the present owner, are allowed.
      const moved = await vfs.update(MEMBER, '/area/mine.txt', { props: { uid: MEMBER.uid, gid: 4100 } });
      assertEquals([moved.props.uid, moved.props.gid], [MEMBER.uid, 4100]);

      // The same holds for a new node.
      await assertRejects(() => vfs.create(MEMBER, 'directory', '/area', 'forged', { props: { uid: OTHER.uid } }), NodeAccessDeniedError);
      await assertRejects(() => vfs.create(MEMBER, 'directory', '/area', 'filed', { props: { gid: OTHER.gid } }), NodeAccessDeniedError);
      const made = await vfs.create(MEMBER, 'directory', '/area', 'filed', { props: { gid: 4100 } });
      assertEquals([made.props.uid, made.props.gid], [MEMBER.uid, 4100]);

      const given = await vfs.update(ADMIN_ACCESS, '/area/mine.txt', { props: { uid: OTHER.uid, gid: OTHER.gid } });
      assertEquals([given.props.uid, given.props.gid], [OTHER.uid, OTHER.gid]);
    });

    await t.step('only the owner or the administrator marks a directory unlisted', async () => {
      const shared = await vfs.create(OWNER, 'directory', '/area', 'shared', { props: { mode: 0o775 } });
      assertEquals(shared.props.uid, OWNER.uid);

      // Write access lets a group mate change other attrs, not hide the tree from everyone.
      await vfs.update(GROUP_MATE, '/area/shared', { attrs: { title: 'Shared' } });
      await assertRejects(() => vfs.update(GROUP_MATE, '/area/shared', { attrs: { [UNLISTED_ATTR]: true } }), NodeAccessDeniedError);

      await vfs.update(OWNER, '/area/shared', { attrs: { [UNLISTED_ATTR]: true } });
      // Restating the present value changes nothing, and is allowed.
      await vfs.update(GROUP_MATE, '/area/shared', { attrs: { title: 'Shared', [UNLISTED_ATTR]: true } });
      await assertRejects(() => vfs.update(GROUP_MATE, '/area/shared', { attrs: { [UNLISTED_ATTR]: null } }), NodeAccessDeniedError);
      await vfs.update(ADMIN_ACCESS, '/area/shared', { attrs: { [UNLISTED_ATTR]: null } });
      assertEquals((await vfs.get(ADMIN_ACCESS, '/area/shared')).attrs[UNLISTED_ATTR], undefined);
    });

    await t.step('admin bypasses all mode bits', async () => {
      await mkfile(vfs, OWNER, '/area', 'locked.txt', 'admin sees', 0o600);
      await vfs.update(OWNER, '/area/locked.txt', { props: { mode: 0o000 } });

      await assertRejects(() => readFile(vfs, OTHER, '/area/locked.txt'), NodeAccessDeniedError);
      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/area/locked.txt'), 'admin sees');
    });

    await t.step('acl user entry grants beyond mode bits', async () => {
      await mkfile(vfs, OWNER, '/area', 'aclfile.txt', 'via acl', 0o600);

      // Denied by mode: OTHER is neither owner nor group and 0o600 gives other nothing
      await assertRejects(() => readFile(vfs, OTHER, '/area/aclfile.txt'), NodeAccessDeniedError);

      // Grant OTHER read via an acl uid entry (0o4 = MaskACL.READ)
      await vfs.update(ADMIN_ACCESS, '/area/aclfile.txt', { props: { acl: [{ uid: OTHER.uid, mode: 0o4 }] } });
      assertEquals(await readFile(vfs, OTHER, '/area/aclfile.txt'), 'via acl');

      // A non-matching subject is still denied
      await assertRejects(() => readFile(vfs, GROUP_MATE, '/area/aclfile.txt'), NodeAccessDeniedError);
    });

    await t.step('acl group entry grants members', async () => {
      await mkfile(vfs, OWNER, '/area', 'grpacl.txt', 'group via acl', 0o600);

      // Grant gid 4000 read via an acl gid entry
      await vfs.update(ADMIN_ACCESS, '/area/grpacl.txt', { props: { acl: [{ gid: 4000, mode: 0o4 }] } });

      // GROUP_MATE.gids includes 4000 -> granted; OTHER.gids does not -> denied
      assertEquals(await readFile(vfs, GROUP_MATE, '/area/grpacl.txt'), 'group via acl');
      await assertRejects(() => readFile(vfs, OTHER, '/area/grpacl.txt'), NodeAccessDeniedError);
    });

    await t.step("a new node is its creator's, in its parent's group", async () => {
      // A shared folder in a group OTHER is not a member of, writable by everyone.
      await mkdir(vfs, ADMIN_ACCESS, '/', 'family', 0o777);
      await vfs.update(ADMIN_ACCESS, '/family', { props: { gid: 4242 } });

      const made = await mkfile(vfs, OTHER, '/family', 'upload.jpg', 'x', 0o775);
      assertEquals([made.props.uid, made.props.gid], [OTHER.uid, 4242]);

      // Its children — a derived node the pipeline adds, say — follow the same rule a level down.
      const child = await mkdir(vfs, ADMIN_ACCESS, '/family/upload.jpg', 'thumbnails');
      assertEquals([child.props.uid, child.props.gid], [ADMIN_ACCESS.uid, 4242]);

      // An explicit group still wins.
      const explicit = await vfs.create(OTHER, 'directory', '/family', 'mine', { props: { gid: OTHER.gid } });
      assertEquals(explicit.props.gid, OTHER.gid);

      // A copy is a create in the destination.
      const copied = await vfs.copy(OWNER, '/area/public.txt', '/family', 'copied.txt');
      assertEquals([copied.props.uid, copied.props.gid], [OWNER.uid, 4242]);
    });

    await t.step('others see a new node only as far as they see its parent', async () => {
      // Parent mode → the mode its new child gets: owner and group everything, others the
      // parent's read and traverse, never its write.
      for (const [parent, child] of [[0o770, 0o770], [0o771, 0o771], [0o775, 0o775], [0o777, 0o775]]) {
        const name = `others-${parent.toString(8)}`;
        await mkdir(vfs, ADMIN_ACCESS, '/', name, parent);
        const made = await vfs.create(ADMIN_ACCESS, 'file', `/${name}`, 'p.jpg');
        assertEquals(made.props.mode.toString(8), child.toString(8));
      }

      // So a guest reads what lands in a folder shared with everyone, and nothing that lands in
      // a group's folder.
      assertEquals(await readFile(vfs, GUEST_ACCESS, '/others-775/p.jpg'), '');
      await assertRejects(() => readFile(vfs, GUEST_ACCESS, '/others-771/p.jpg'), NodeAccessDeniedError);
    });

    await t.step('a listing leaves out the children the caller may not read', async () => {
      // A shared folder holding private albums between shared ones, as a page sees them.
      await mkdir(vfs, OWNER, '/area', 'albums', 0o755);
      for (const name of ['a', 'b', 'c', 'd', 'e']) await mkdir(vfs, OWNER, '/area/albums', name, ['b', 'c'].includes(name) ? 0o700 : 0o755);

      const names = (listing: { name: string }[]) => listing.map((child) => child.name);
      assertEquals(names(await vfs.children(OWNER, '/area/albums')), ['a', 'b', 'c', 'd', 'e']);
      assertEquals(names(await vfs.children(OTHER, '/area/albums')), ['a', 'd', 'e']);
      assertEquals(names(await vfs.children(ADMIN_ACCESS, '/area/albums')), ['a', 'b', 'c', 'd', 'e']);

      // A page is read on past the hidden ones, so a short page still means the end.
      assertEquals(names(await vfs.children(OTHER, '/area/albums', { page: { limit: 2 } })), ['a', 'd']);
      assertEquals(names(await vfs.children(OTHER, '/area/albums', { page: { limit: 2, after: 'd' } })), ['e']);

      const [many] = await vfs.childrenMany(OTHER, ['/area/albums']);
      assertEquals(many.status === 'fulfilled' ? names(many.value) : many.reason, ['a', 'd', 'e']);
    });

    await t.step('a count covers the children the caller may read, unless asked for all', async () => {
      // /area/albums holds five albums, two of them private (the step above); album a holds one
      // photo kept private.
      await mkfile(vfs, OWNER, '/area/albums/a', 'shared.jpg', '', 0o644);
      await mkfile(vfs, OWNER, '/area/albums/a', 'private.jpg', '', 0o600);

      assertEquals(await vfs.childCount(OWNER, '/area/albums'), 5);
      assertEquals(await vfs.childCount(OTHER, '/area/albums'), 3);
      assertEquals(await vfs.childCount(OTHER, '/area/albums', { all: true }), 5);

      const countOf = (listing: { name: string; childCount: number }[], name: string) => listing.find((child) => child.name === name)?.childCount;
      assertEquals(countOf(await vfs.children(OWNER, '/area/albums'), 'a'), 2);
      assertEquals(countOf(await vfs.children(OTHER, '/area/albums'), 'a'), 1);
      assertEquals(countOf(await vfs.children(OTHER, '/area/albums', { all: true }), 'a'), 2);
      assertEquals(countOf(await vfs.children(OTHER, '/area', { page: { limit: 100 } }), 'albums'), 3);

      const [many] = await vfs.childrenMany(OTHER, ['/area/albums']);
      assertEquals(many.status === 'fulfilled' ? countOf(many.value, 'a') : many.reason, 1);
      const [all] = await vfs.childrenMany(OTHER, ['/area/albums'], { all: true });
      assertEquals(all.status === 'fulfilled' ? countOf(all.value, 'a') : all.reason, 2);
    });

    await t.step('a listing’s child edges name only the children the caller may read', async () => {
      const edgesOf = async (access: Access) =>
        (await vfs.children(access, '/area/albums', { childLinks: true })).find((child) => child.name === 'a')?.children?.map((link) => link.name).sort();
      assertEquals(await edgesOf(OWNER), ['private.jpg', 'shared.jpg']);
      assertEquals(await edgesOf(OTHER), ['shared.jpg']);
    });
  } finally {
    await ctx.dispose();
  }
});
