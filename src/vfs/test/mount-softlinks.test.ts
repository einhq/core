/**
 * A softlink stored inside a mount names a path in the global namespace, as a softlink anywhere
 * else does: an absolute target from the outermost root, a relative one from the link's own
 * directory as the caller sees it — through nested mounts and out of them.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { NodeNotFoundError } from '../errors.ts';

Deno.test('softlinks inside a mount resolve against the global root', async (t) => {
  const outer = await createTestVfs();
  const tmp = await createTestVfs();
  const inner = await createTestVfs();
  const dir = { props: { mode: 0o755 } };
  const file = { props: { mode: 0o644 } };
  const link = (softlink: string) => ({ props: { mode: 0o777, softlink } });

  await outer.vfs.create(ADMIN_ACCESS, 'directory', '/', 'tmp', dir);
  await outer.vfs.create(ADMIN_ACCESS, 'directory', '/', 'archive', dir);
  const top = await outer.vfs.create(ADMIN_ACCESS, 'file', '/archive', 'top', file);
  await outer.vfs.mount(ADMIN_ACCESS, '/tmp', tmp.vfs);
  await outer.vfs.create(ADMIN_ACCESS, 'directory', '/tmp', 't', dir);
  const f = await outer.vfs.create(ADMIN_ACCESS, 'file', '/tmp/t', 'f', file);
  await outer.vfs.create(ADMIN_ACCESS, 'directory', '/tmp', 'inner', dir);
  await outer.vfs.mount(ADMIN_ACCESS, '/tmp/inner', inner.vfs);
  const deep = await outer.vfs.create(ADMIN_ACCESS, 'file', '/tmp/inner', 'deep', file);

  const id = async (path: string) => (await outer.vfs.get(ADMIN_ACCESS, path)).id;

  await t.step('an absolute target inside the same mount', async () => {
    await outer.vfs.create(ADMIN_ACCESS, 'softlink', '/tmp/t', 'to-tmp', link('/tmp/t/f'));
    assertEquals(await id('/tmp/t/to-tmp'), f.id);
  });

  await t.step('an absolute target outside the mount', async () => {
    await outer.vfs.create(ADMIN_ACCESS, 'softlink', '/tmp/t', 'to-root', link('/archive'));
    assertEquals(await id('/tmp/t/to-root/top'), top.id);
  });

  await t.step('a relative target, from the directory holding the link', async () => {
    await outer.vfs.create(ADMIN_ACCESS, 'softlink', '/tmp/t', 'rel', link('f'));
    await outer.vfs.create(ADMIN_ACCESS, 'softlink', '/tmp/t', 'up', link('../../archive'));
    assertEquals(await id('/tmp/t/rel'), f.id);
    assertEquals(await id('/tmp/t/up/top'), top.id);
  });

  await t.step('from a nested mount, relative and absolute', async () => {
    await outer.vfs.create(ADMIN_ACCESS, 'softlink', '/tmp/inner', 'out', link('../t/f'));
    await outer.vfs.create(ADMIN_ACCESS, 'softlink', '/tmp/inner', 'abs', link('/archive/top'));
    await outer.vfs.create(ADMIN_ACCESS, 'softlink', '/tmp/t', 'in', link('../inner'));
    assertEquals(await id('/tmp/inner/out'), f.id);
    assertEquals(await id('/tmp/inner/abs'), top.id);
    assertEquals(await id('/tmp/t/in/deep'), deep.id);
  });

  await t.step('a followed link answers with its target', async () => {
    assertEquals((await outer.vfs.resolvePath(ADMIN_ACCESS, '/tmp/t/to-root/top')).absPath, '/archive/top');
    await outer.vfs.create(ADMIN_ACCESS, 'softlink', '/tmp/t', 'dangling', link('/archive/nope'));
    await assertRejects(() => outer.vfs.get(ADMIN_ACCESS, '/tmp/t/dangling'), NodeNotFoundError, '/archive/nope');
  });

  await t.step('readlink and follow:false still return the link', async () => {
    const node = await outer.vfs.get(ADMIN_ACCESS, '/tmp/t/to-root', { follow: false });
    assertEquals(node.props.softlink, '/archive');
  });
});
