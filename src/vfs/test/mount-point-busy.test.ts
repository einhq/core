/**
 * A mount point cannot be removed or moved, nor can anything above it, while something is mounted
 * on it, and a mount is unmounted by
 * the path `mounts` lists, also when a later mount covers its point.
 */

import { assert, assertEquals, assertRejects } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { NodeBusyError } from '../errors.ts';
import { mkdir, mkdirp, mkfile } from './helpers.ts';

Deno.test('VFS mount point removal and unmount', async (t) => {
  const { vfs } = await createTestVfs();
  const mounted = await createTestVfs();
  await mkdirp(vfs, ADMIN_ACCESS, '/t/mnt');
  await mkfile(vfs, ADMIN_ACCESS, '/t', 'keep.txt', 'keep');
  await vfs.mount(ADMIN_ACCESS, '/t/mnt', mounted.vfs);

  const listed = () => vfs.mounts(ADMIN_ACCESS).map((m) => m.point.absPath);

  await t.step('a recursive unlink above a mount point is refused before anything goes', async () => {
    const error = await assertRejects(() => vfs.unlink(ADMIN_ACCESS, '/t', '/', { recursive: true }), NodeBusyError);
    assertEquals(error.message, 'a filesystem is mounted at /t/mnt');
    assertEquals((await vfs.children(ADMIN_ACCESS, '/t')).map((c) => c.name).sort(), ['keep.txt', 'mnt']);
  });

  await t.step('the mount point itself is not unlinked', async () => {
    await assertRejects(() => vfs.unlink(ADMIN_ACCESS, '!/t/mnt', '/t'), NodeBusyError);
  });

  await t.step('a rename onto the mount point does not replace it', async () => {
    await mkdir(vfs, ADMIN_ACCESS, '/', 'other');
    await assertRejects(() => vfs.rename(ADMIN_ACCESS, '/', 'other', '/t', 'mnt'), NodeBusyError);
    assertEquals(listed(), ['/t/mnt']);
  });

  await t.step('neither the mount point nor anything above it moves', async () => {
    let error = await assertRejects(() => vfs.rename(ADMIN_ACCESS, '/', 't', '/', 'u'), NodeBusyError);
    assertEquals(error.message, 'a filesystem is mounted at /t/mnt');
    error = await assertRejects(() => vfs.rename(ADMIN_ACCESS, '/t', 'mnt', '/t', 'moved'), NodeBusyError);
    assertEquals(error.message, 'a filesystem is mounted at /t/mnt');
    assertEquals(listed(), ['/t/mnt']);
    assertEquals((await vfs.children(ADMIN_ACCESS, '/')).map((c) => c.name).sort(), ['other', 't']);
  });

  await t.step('a move into another VFS is refused before anything is copied', async () => {
    const dest = await createTestVfs();
    await mkdir(vfs, ADMIN_ACCESS, '/', 'dest');
    await vfs.mount(ADMIN_ACCESS, '/dest', dest.vfs);

    const error = await assertRejects(() => vfs.rename(ADMIN_ACCESS, '/', 't', '/dest', 't'), NodeBusyError);
    assertEquals(error.message, 'a filesystem is mounted at /t/mnt');
    assertEquals(await vfs.children(ADMIN_ACCESS, '/dest'), []);
    assertEquals(listed(), ['/t/mnt', '/dest']);

    await vfs.unmount(ADMIN_ACCESS, '/dest');
  });

  await t.step("a move out of another VFS is refused above that VFS's own mount", async () => {
    const outer = await createTestVfs();
    const inner = await createTestVfs();
    await mkdir(vfs, ADMIN_ACCESS, '/', 'src');
    await vfs.mount(ADMIN_ACCESS, '/src', outer.vfs);
    await mkdirp(vfs, ADMIN_ACCESS, '/src/a/mnt');
    await vfs.mount(ADMIN_ACCESS, '/src/a/mnt', inner.vfs);

    const error = await assertRejects(() => vfs.rename(ADMIN_ACCESS, '/src', 'a', '/', 'a'), NodeBusyError);
    assertEquals(error.message, 'a filesystem is mounted at /src/a/mnt');
    assert(!await vfs.exists(ADMIN_ACCESS, '/a'));

    await vfs.unmount(ADMIN_ACCESS, '/src/a/mnt');
    await vfs.unmount(ADMIN_ACCESS, '/src');
  });

  await t.step('once unmounted, the tree goes', async () => {
    await vfs.unmount(ADMIN_ACCESS, '/t/mnt');
    assertEquals(listed(), []);
    assert(await vfs.unlink(ADMIN_ACCESS, '/t', '/', { recursive: true }));
  });

  await t.step('a mount inside another mount is refused and unmounted by the full path', async () => {
    const tmp = await createTestVfs();
    const inner = await createTestVfs();
    await mkdir(vfs, ADMIN_ACCESS, '/', 'tmp');
    await vfs.mount(ADMIN_ACCESS, '/tmp', tmp.vfs);
    await mkdirp(vfs, ADMIN_ACCESS, '/tmp/t/mnt');
    await vfs.mount(ADMIN_ACCESS, '/tmp/t/mnt', inner.vfs);
    assertEquals(listed(), ['/tmp', '/tmp/t/mnt']);

    const error = await assertRejects(() => vfs.unlink(ADMIN_ACCESS, '/tmp/t', '/tmp', { recursive: true }), NodeBusyError);
    assertEquals(error.message, 'a filesystem is mounted at /tmp/t/mnt');

    await vfs.unmount(ADMIN_ACCESS, '/tmp/t/mnt');
    assertEquals(listed(), ['/tmp']);
    await vfs.unmount(ADMIN_ACCESS, '/tmp');
  });

  await t.step('a mount point covered by a mount at the root is unmounted by its path', async () => {
    const files = await createTestVfs();
    const root = await createTestVfs();
    await mkdir(vfs, ADMIN_ACCESS, '/', '_files');
    await vfs.mount(ADMIN_ACCESS, '/_files', files.vfs);
    await vfs.mount(ADMIN_ACCESS, '/', root.vfs);
    assertEquals(listed(), ['/_files', '/']);

    await vfs.unmount(ADMIN_ACCESS, '/_files');
    assertEquals(listed(), ['/']);
  });
});
