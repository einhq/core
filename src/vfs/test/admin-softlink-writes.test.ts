/**
 * An administrator's write does not go through a softlink a member laid, wherever on the path it
 * is: under a member's file, where pipeline steps write `metadata/`, `thumbnails/`, `regions/` and
 * `versions/` as the administrator. A read still follows it, a member's own write is held to their
 * own access, and a node is hard-linked only by whoever owns it or may write it.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { type Access, ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { NodeAccessDeniedError } from '../errors.ts';
import { mkdir, mkfile, readFile } from './helpers.ts';

const ANNA: Access = { uid: 5100, gid: 5100, gids: [5100] };
const BO: Access = { uid: 5200, gid: 5200, gids: [5200] };

const link = (softlink: string) => ({ props: { mode: 0o777, softlink } });

Deno.test('an administrator writes through no softlink a member laid', async (t) => {
  const ctx = await createTestVfs();
  const tmp = await createTestVfs();
  const { vfs } = ctx;

  const refused = (write: () => Promise<unknown>, path: string) =>
    assertRejects(write, NodeAccessDeniedError, `write through a softlink owned by uid ${ANNA.uid}' on node: ${path}`);

  try {
    await mkdir(vfs, ADMIN_ACCESS, '/', 'home');
    await mkdir(vfs, ADMIN_ACCESS, '/', 'etc');
    await vfs.create(ADMIN_ACCESS, 'directory', '/home', 'anna', { props: { mode: 0o700, uid: ANNA.uid, gid: ANNA.gid } });
    await vfs.create(ADMIN_ACCESS, 'directory', '/home', 'bo', { props: { mode: 0o700, uid: BO.uid, gid: BO.gid } });
    await mkdir(vfs, BO, '/home/bo', 'private', 0o700);
    await mkfile(vfs, BO, '/home/bo/private', 'notes.txt', 'bo');
    await mkfile(vfs, ADMIN_ACCESS, '/etc', 'bashrc', 'export PS1');

    // What a member lays under a file of theirs, in place of the folders steps write in.
    await mkfile(vfs, ANNA, '/home/anna', 'a.txt', 'text', 0o750);
    const file = '/home/anna/a.txt';
    await vfs.create(ANNA, 'softlink', file, 'metadata', link('/home/bo'));
    await vfs.create(ANNA, 'softlink', file, 'thumbnails', link('/home/bo/private'));
    await vfs.create(ANNA, 'softlink', file, 'chromaprint', link('/etc/bashrc'));
    await vfs.create(ANNA, 'softlink', file, 'picture', link('/home/bo/private'));
    await mkdir(vfs, ANNA, file, 'regions');
    await vfs.create(ANNA, 'softlink', `${file}/regions`, 'face-1', link('/etc/bashrc'));

    const bosNames = async () => (await vfs.children(ADMIN_ACCESS, '/home/bo/private')).map((child) => child.name).sort();

    await t.step('a child is not created under it, by any of the ways to create one', async () => {
      await refused(() => vfs.create(ADMIN_ACCESS, 'file', `${file}/metadata`, 'content'), `${file}/metadata`);
      await refused(() => vfs.ensure(ADMIN_ACCESS, 'directory', `${file}/thumbnails`, 'tmp'), `${file}/thumbnails`);
      await refused(() => vfs.createTree(ADMIN_ACCESS, `${file}/metadata`, [{ type: 'directory', name: 'x' }]), `${file}/metadata`);
      await refused(
        () => vfs.writeTree(ADMIN_ACCESS, `${file}/metadata`, (async function* () {/* nothing to write */})()),
        `${file}/metadata`,
      );
      await refused(() => vfs.copy(ADMIN_ACCESS, file, `${file}/thumbnails`, 'copy.txt'), `${file}/thumbnails`);
      assertEquals((await vfs.children(ADMIN_ACCESS, '/home/bo')).map((child) => child.name), ['private']);
    });

    await t.step('the node it leads to is neither written nor changed', async () => {
      await refused(() => vfs.open(ADMIN_ACCESS, `${file}/chromaprint`, { mode: 'w' }), `${file}/chromaprint`);
      await refused(() => vfs.open(ADMIN_ACCESS, `${file}/regions/face-1`, { mode: 'a' }), `${file}/regions/face-1`);
      await refused(() => vfs.update(ADMIN_ACCESS, `${file}/chromaprint`, { attrs: { x: 1 } }), `${file}/chromaprint`);
      const [many] = await vfs.updateMany(ADMIN_ACCESS, [`${file}/chromaprint`], { props: { mode: 0o666 } });
      const [each] = await vfs.updateEach(ADMIN_ACCESS, [{ ref: `${file}/thumbnails/notes.txt`, attrs: { x: 1 } }]);
      assertEquals([many.status, each.status], ['rejected', 'rejected']);
      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/etc/bashrc'), 'export PS1');
      assertEquals((await vfs.get(ADMIN_ACCESS, '/etc/bashrc')).props.mode, 0o644);
    });

    await t.step('nothing is moved into it or removed through it', async () => {
      await mkfile(vfs, ADMIN_ACCESS, file, 'tmp-thumb', 'thumb');
      await refused(() => vfs.rename(ADMIN_ACCESS, file, 'tmp-thumb', `${file}/thumbnails`, 'small.jpg'), `${file}/thumbnails`);
      const [moved] = await vfs.renameMany(ADMIN_ACCESS, [{ from: `${file}/tmp-thumb`, to: `${file}/thumbnails/small.jpg` }]);
      assertEquals(moved.status, 'rejected');
      await refused(() => vfs.unlink(ADMIN_ACCESS, `${file}/picture`, file, { recursive: true }), `${file}/picture`);
      await refused(() => vfs.unlink(ADMIN_ACCESS, `${file}/thumbnails/notes.txt`, `${file}/thumbnails`), `${file}/thumbnails`);
      const [removed] = await vfs.unlinkMany(ADMIN_ACCESS, [`${file}/thumbnails/notes.txt`]);
      assertEquals(removed.status, 'rejected');
      assertEquals(await bosNames(), ['notes.txt']);
    });

    await t.step('the link itself is still read through, and removed as itself', async () => {
      assertEquals((await vfs.get(ADMIN_ACCESS, `${file}/chromaprint`)).props.mode, 0o644);
      assertEquals(await readFile(vfs, ADMIN_ACCESS, `${file}/thumbnails/notes.txt`), 'bo');
      await vfs.unlink(ADMIN_ACCESS, `${file}/picture`, file, { recursive: true, readlink: true });
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${file}/picture`, { readlink: true }), false);
      assertEquals(await bosNames(), ['notes.txt']);
    });

    await t.step("an administrator's own link is written through", async () => {
      await vfs.create(ADMIN_ACCESS, 'softlink', '/etc', 'rc', link('/etc/bashrc'));
      await vfs.update(ADMIN_ACCESS, '/etc/rc', { attrs: { x: 1 } });
      assertEquals((await vfs.get(ADMIN_ACCESS, '/etc/bashrc')).attrs.x, 1);
    });

    await t.step("a member's write through their own link is theirs to make", async () => {
      await mkdir(vfs, ANNA, '/home/anna', 'real');
      await vfs.create(ANNA, 'softlink', '/home/anna', 'alias', link('/home/anna/real'));
      await mkfile(vfs, ANNA, '/home/anna/alias', 'kept.txt', 'mine');
      assertEquals(await readFile(vfs, ANNA, '/home/anna/real/kept.txt'), 'mine');
      await assertRejects(() => vfs.create(ANNA, 'file', `${file}/metadata`, 'content'), NodeAccessDeniedError, "operation 'w'");
    });

    await t.step('a link inside a mount is judged the same, named by its path from the root', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/', 'tmp');
      await vfs.mount(ADMIN_ACCESS, '/tmp', tmp.vfs);
      await mkdir(vfs, ADMIN_ACCESS, '/tmp', 'shared', 0o777);
      await vfs.create(ANNA, 'softlink', '/tmp/shared', 'out', link('/home/bo/private'));
      await refused(() => vfs.create(ADMIN_ACCESS, 'file', '/tmp/shared/out', 'planted'), '/tmp/shared/out');
      assertEquals(await bosNames(), ['notes.txt']);
    });

    await t.step("someone else's node is hard-linked only by who may write it", async () => {
      await assertRejects(() => vfs.link(ANNA, '/etc/bashrc', file, 'content'), NodeAccessDeniedError, "operation 'link'");
      await vfs.link(ANNA, file, '/home/anna', 'b.txt');
      await vfs.create(ADMIN_ACCESS, 'file', '/etc', 'shared', { props: { mode: 0o666 } });
      await vfs.link(ANNA, '/etc/shared', file, 'shared');
      assertEquals((await vfs.get(ADMIN_ACCESS, '/etc/shared')).props.count, 2);
    });
  } finally {
    await ctx.dispose();
    await tmp.dispose();
  }
});
