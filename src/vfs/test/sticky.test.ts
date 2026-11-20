/**
 * A sticky directory: whoever may write it adds to it, but only an entry's owner, the directory's
 * owner, an administrator or whoever may write the entry may remove, move or replace it. In one everyone writes (`/tmp`),
 * what is created is its creator's alone; in one a group writes (an archive root), it is created
 * as anywhere else, in the directory's group.
 */

import { assert, assertEquals, assertRejects } from '@std/assert';
import type { Access } from '../../lib/access/mod.ts';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { NodeAccessDeniedError } from '../mod.ts';
import { mkdir, mkfile, readFile } from './helpers.ts';

const ALICE: Access = { uid: 5000, gid: 5000, gids: [5000, 4000] };
const BOB: Access = { uid: 5001, gid: 5001, gids: [5001, 4000] };
const KEEPER: Access = { uid: 5002, gid: 5002, gids: [5002] };

Deno.test('a sticky directory', async (t) => {
  const ctx = await createTestVfs();
  const { vfs } = ctx;

  try {
    await mkdir(vfs, ADMIN_ACCESS, '/', 'tmp', 0o1777);
    await vfs.update(ADMIN_ACCESS, '/tmp', { props: { gid: 4000 } });
    await mkdir(vfs, ADMIN_ACCESS, '/', 'kept', 0o1777);
    await vfs.update(ADMIN_ACCESS, '/kept', { props: { uid: KEEPER.uid, gid: KEEPER.gid } });

    await t.step("what is made there is the creator's alone, in their own group", async () => {
      await vfs.create(ALICE, 'file', '/tmp', 'note', { attrs: { name: 'note', mimetype: 'text/plain', size: 0 } });
      await vfs.create(ALICE, 'directory', '/tmp', 'work');

      for (const path of ['/tmp/note', '/tmp/work']) {
        const { props } = await vfs.get(ADMIN_ACCESS, path);
        assertEquals([props.mode, props.uid, props.gid], [0o700, ALICE.uid, ALICE.gid]);
      }
      await assertRejects(() => readFile(vfs, BOB, '/tmp/note'), NodeAccessDeniedError);
    });

    await t.step("another member may not remove someone else's entry, recursively or not", async () => {
      await mkfile(vfs, ALICE, '/tmp', 'shared', 'readable', 0o744);

      await assertRejects(() => vfs.unlink(BOB, '/tmp/shared', '/tmp'), NodeAccessDeniedError, 'node: /tmp/shared');
      await assertRejects(() => vfs.unlink(BOB, '/tmp/work', '/tmp', { recursive: true }), NodeAccessDeniedError);
      const [one, many] = await vfs.unlinkMany(BOB, ['/tmp/shared', '/tmp/work'], { recursive: true });
      assert(one.status === 'rejected' && one.reason instanceof NodeAccessDeniedError);
      assert(many.status === 'rejected' && many.reason instanceof NodeAccessDeniedError);
      assert(await vfs.exists(ADMIN_ACCESS, '/tmp/shared'));
      assert(await vfs.exists(ADMIN_ACCESS, '/tmp/work'));
    });

    await t.step("another member may not move someone else's entry away, or replace it by a move", async () => {
      await assertRejects(() => vfs.rename(BOB, '/tmp', 'shared', '/tmp', 'taken'), NodeAccessDeniedError);
      await mkfile(vfs, BOB, '/tmp', 'bobs', 'mine');
      await assertRejects(() => vfs.rename(BOB, '/tmp', 'bobs', '/tmp', 'shared'), NodeAccessDeniedError);
      const [moved] = await vfs.renameMany(BOB, [{ from: '/tmp/bobs', to: '/tmp/shared' }]);
      assert(moved.status === 'rejected' && moved.reason instanceof NodeAccessDeniedError);
      assertEquals(await readFile(vfs, ALICE, '/tmp/shared'), 'readable');
    });

    await t.step('the owner of the entry, the owner of the directory, an administrator and whoever may write the entry may', async () => {
      await vfs.rename(ALICE, '/tmp', 'shared', '/tmp', 'renamed');
      await vfs.unlink(ALICE, '/tmp/renamed', '/tmp');
      await vfs.unlink(BOB, '/tmp/bobs', '/tmp');
      await vfs.unlink(ADMIN_ACCESS, '/tmp/work', '/tmp', { recursive: true });

      await mkfile(vfs, ALICE, '/kept', 'left', 'x');
      await vfs.unlink(KEEPER, '/kept/left', '/kept');
      assert(!(await vfs.exists(ADMIN_ACCESS, '/kept/left')));

      await mkfile(vfs, ALICE, '/tmp', 'open', 'anyone may change it', 0o777);
      await vfs.unlink(BOB, '/tmp/open', '/tmp');
    });

    await t.step("in a group's sticky directory what is made takes the group, and the group removes only what it may change", async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/', 'albums', 0o1771);
      await vfs.update(ADMIN_ACCESS, '/albums', { props: { gid: 4000 } });
      await vfs.create(ALICE, 'directory', '/albums', 'summer');
      const { props } = await vfs.get(ADMIN_ACCESS, '/albums/summer');
      assertEquals([props.mode, props.uid, props.gid], [0o771, ALICE.uid, 4000]);

      await mkdir(vfs, ALICE, '/albums', 'private', 0o700);
      await mkdir(vfs, ALICE, '/albums', 'shown', 0o750);
      await assertRejects(() => vfs.unlink(BOB, '/albums/private', '/albums'), NodeAccessDeniedError, 'sticky');
      await assertRejects(() => vfs.unlink(BOB, '/albums/shown', '/albums'), NodeAccessDeniedError, 'sticky');
      await vfs.unlink(BOB, '/albums/summer', '/albums');
      await vfs.unlink(ALICE, '/albums/private', '/albums');
    });

    await t.step('a sticky entry the group writes is removed only by its owner or the directory’s', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/', 'archive', 0o1771);
      await vfs.update(ADMIN_ACCESS, '/archive', { props: { gid: 4000 } });
      await mkdir(vfs, ADMIN_ACCESS, '/archive', 'recipes', 0o1771);
      await assertRejects(() => vfs.unlink(BOB, '/archive/recipes', '/archive'), NodeAccessDeniedError, 'sticky');
      await assertRejects(() => vfs.rename(BOB, '/archive', 'recipes', '/archive', 'mine'), NodeAccessDeniedError, 'sticky');
      await vfs.unlink(ADMIN_ACCESS, '/archive/recipes', '/archive');
    });
  } finally {
    await ctx.dispose();
  }
});
