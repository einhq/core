/**
 * End-to-end tiered storage: drives a real LocalNodeVFS whose file registry
 * fans out to two distinct on-disk roots (disk + volatile) and a memory db
 * backend, and asserts a node's bytes physically land on the root its attrs
 * select — through the real create -> open -> write -> stat -> delete path.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { toText } from '@std/streams/to-text';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { RouterManager } from '../../managers/router/mod.ts';
import { MemoryBlobRegistry } from '../../registries/blob/mod.ts';
import { DiskFileRegistry, TieredFileRegistry } from '../../registries/file/mod.ts';
import type { FileTier } from '../../registries/file/types.ts';
import { InMemoryStore } from '../../stores/memory/index.ts';
import { LocalNodeVFS, NodeTierImmutableError } from '../mod.ts';

const enc = new TextEncoder();

Deno.test('tiered storage routes bytes to the physical tier root', async (t) => {
  const diskRoot = await Deno.makeTempDir({ prefix: 'mrx-disk-' });
  const volatileRoot = await Deno.makeTempDir({ prefix: 'mrx-vol-' });

  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();

  const vfs = new LocalNodeVFS(new InMemoryStore({}), routerManager, {
    file: new TieredFileRegistry({
      disk: new DiskFileRegistry({ rootPath: diskRoot }),
      volatile: new DiskFileRegistry({ rootPath: volatileRoot }),
      db: new MemoryBlobRegistry(),
    }),
  });
  await vfs.initialize();

  const write = async (name: string, attrs: Record<string, unknown>, body: string): Promise<string> => {
    // tier is an immutable node prop; split it out of the attrs bag.
    const { tier, ...rest } = attrs as { tier?: FileTier } & Record<string, unknown>;
    await vfs.create(ADMIN_ACCESS, 'file', '/', name, { props: tier ? { tier } : undefined, attrs: rest });
    const handle = await vfs.open(ADMIN_ACCESS, `/${name}`, { mode: 'w' });
    await handle.write(enc.encode(body));
    await handle.close();
    return (await vfs.get(ADMIN_ACCESS, `/${name}`)).id;
  };
  const onDisk = (root: string, id: string) => Deno.stat(`${root}/${id.slice(-2)}/${id}`).then(() => true).catch(() => false);
  const readBack = async (name: string): Promise<string> => {
    const handle = await vfs.open(ADMIN_ACCESS, `/${name}`, { mode: 'r' });
    try {
      return await toText(handle.readable);
    } finally {
      await handle.close();
    }
  };

  let origId = '';
  let thumbId = '';
  let dbId = '';

  try {
    await t.step('original (no sourceId) -> disk root', async () => {
      origId = await write('orig.jpg', { name: 'orig.jpg', mimetype: 'image/jpeg', size: 0 }, 'ORIGINAL');
      assert(await onDisk(diskRoot, origId), 'original bytes on disk root');
      assert(!(await onDisk(volatileRoot, origId)), 'original not on volatile root');
      assertStringIncludes((await vfs.stat(ADMIN_ACCESS, '/orig.jpg')).path as string, diskRoot);
    });

    await t.step('rendition (sourceId, not frozen) -> volatile root', async () => {
      thumbId = await write('thumb.webp', { name: 'thumb.webp', mimetype: 'image/webp', size: 0, sourceId: origId }, 'THUMB');
      assert(await onDisk(volatileRoot, thumbId), 'rendition bytes on volatile root');
      assert(!(await onDisk(diskRoot, thumbId)), 'rendition not on disk root');
      assertStringIncludes((await vfs.stat(ADMIN_ACCESS, '/thumb.webp')).path as string, volatileRoot);
    });

    await t.step('db-tier file -> neither disk root (PostgreSQL LOB / memory)', async () => {
      dbId = await write('note.md', { name: 'note.md', mimetype: 'text/markdown', size: 0, tier: 'db' }, 'NOTE');
      assert(!(await onDisk(diskRoot, dbId)), 'db file not on disk root');
      assert(!(await onDisk(volatileRoot, dbId)), 'db file not on volatile root');
    });

    await t.step('all three read back byte-exact through the VFS', async () => {
      assertEquals(await readBack('orig.jpg'), 'ORIGINAL');
      assertEquals(await readBack('thumb.webp'), 'THUMB');
      assertEquals(await readBack('note.md'), 'NOTE');
    });

    await t.step('tier is immutable once set', async () => {
      // changing a set tier is rejected (bytes would be stranded)
      await assertRejects(
        () => vfs.update(ADMIN_ACCESS, '/note.md', { props: { tier: 'disk' } }),
        NodeTierImmutableError,
      );
      // setting a tier on a file that never had one is likewise rejected (create-only)
      await assertRejects(
        () => vfs.update(ADMIN_ACCESS, '/orig.jpg', { props: { tier: 'db' } }),
        NodeTierImmutableError,
      );
      // re-sending the identical value is a no-op and content is intact
      await vfs.update(ADMIN_ACCESS, '/note.md', { props: { tier: 'db' } });
      assertEquals(await readBack('note.md'), 'NOTE');
    });

    await t.step('a frozen file is read-only on disk, and writable again once the mark is lifted', async () => {
      const mode = async (name: string) => (await Deno.stat((await vfs.stat(ADMIN_ACCESS, `/${name}`)).path as string)).mode! & 0o777;
      const before = await mode('orig.jpg');
      assert(before & 0o200, 'an original starts writable');

      await vfs.update(ADMIN_ACCESS, '/orig.jpg', { attrs: { frozen: true } });
      assertEquals(await mode('orig.jpg'), before & ~0o222);

      // A copy is frozen, on disk too, and keeps what was frozen readable through the VFS
      await vfs.copy(ADMIN_ACCESS, '/orig.jpg', '/', 'orig-copy.jpg');
      assertEquals((await vfs.get(ADMIN_ACCESS, '/orig-copy.jpg')).attrs.frozen, true);
      assertEquals((await mode('orig-copy.jpg')) & 0o222, 0);
      assertEquals(await readBack('orig-copy.jpg'), 'ORIGINAL');

      await vfs.update(ADMIN_ACCESS, '/orig.jpg', { attrs: { frozen: null } });
      assertEquals(await mode('orig.jpg'), (before & ~0o222) | 0o200);
      const handle = await vfs.open(ADMIN_ACCESS, '/orig.jpg', { mode: 'w' });
      await handle.write(enc.encode('ORIGINAL'));
      await handle.close();
    });

    await t.step('deleting a rendition frees the volatile root', async () => {
      await vfs.unlink(ADMIN_ACCESS, '/thumb.webp', '/');
      assert(!(await onDisk(volatileRoot, thumbId)), 'rendition bytes removed from volatile root');
    });
  } finally {
    await vfs.dispose();
    await routerManager.dispose();
    await Deno.remove(diskRoot, { recursive: true });
    await Deno.remove(volatileRoot, { recursive: true });
  }
});
