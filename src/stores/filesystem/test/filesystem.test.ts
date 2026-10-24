/**
 * FilesystemStore through LocalNodeVFS against a temp directory: listing, reads, writes,
 * softlinks, and ids derived from the path.
 */

import { assertEquals, assertExists, assertRejects } from '@std/assert';
import { join } from '@std/path';
import { toText } from '@std/streams';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { RouterManager } from '../../../managers/router/mod.ts';
import { DiskFileRegistry } from '../../../registries/file/mod.ts';
import { LocalNodeVFS, NodeNotFoundError } from '../../../vfs/mod.ts';
import { FilesystemStore } from '../index.ts';

async function setupTestDir(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: 'filesystem-store-test-' });
  await Deno.mkdir(join(dir, 'subdir'));
  await Deno.writeTextFile(join(dir, 'file1.txt'), 'Hello World');
  await Deno.writeTextFile(join(dir, 'subdir', 'file2.txt'), 'Nested file');
  await Deno.symlink('../file1.txt', join(dir, 'subdir', 'link-to-file1'));
  return dir;
}

Deno.test('FilesystemStore', async (t) => {
  const testDir = await setupTestDir();

  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();

  const store = new FilesystemStore({ rootPath: testDir });
  const fileRegistry = new DiskFileRegistry({ rootPath: testDir });
  const vfs = new LocalNodeVFS(store, routerManager, { file: fileRegistry });

  try {
    await vfs.initialize();

    await t.step('get - root', async () => {
      const root = await vfs.get(ADMIN_ACCESS, '/');
      assertEquals(root.type, 'directory');
      assertExists(root.id);
      assertEquals(await vfs.childCount(ADMIN_ACCESS, '/'), 2); // file1.txt, subdir
    });

    await t.step('resolvePath and get - file', async () => {
      const file = await vfs.get(ADMIN_ACCESS, '/file1.txt');
      assertEquals(file.type, 'file');
      assertEquals(file.attrs.size, 11); // "Hello World".length
      assertEquals(file.attrs.name, 'file1.txt');
      assertEquals(file.attrs.mimetype, 'text/plain');
    });

    await t.step('get - nested directory', async () => {
      const subdir = await vfs.get(ADMIN_ACCESS, '/subdir');
      assertEquals(subdir.type, 'directory');
      assertEquals(await vfs.childCount(ADMIN_ACCESS, '/subdir'), 2); // file2.txt, link-to-file1
    });

    await t.step('get - symlink', async () => {
      const link = await vfs.get(ADMIN_ACCESS, '/subdir/link-to-file1', { follow: false });
      assertEquals(link.type, 'softlink');
      assertEquals(link.props.softlink, '../file1.txt');
    });

    await t.step('resolvePath - not found', async () => {
      await assertRejects(
        () => vfs.resolvePath(ADMIN_ACCESS, '/nonexistent'),
        NodeNotFoundError,
      );
    });

    await t.step('store getNode - by id', async () => {
      const entry = await vfs.resolvePath(ADMIN_ACCESS, '/file1.txt');
      const node = await store.getNode(entry.id);
      assertEquals(node.id, entry.id);
      assertEquals(node.type, 'file');
    });

    await t.step('store lookup by name or id is the one entry, without its child count', async () => {
      const root = store.rootId;
      const subdir = (await vfs.resolvePath(ADMIN_ACCESS, '/subdir')).id;

      const [byName, ...restByName] = await store.getChildren(root, { name: 'subdir' });
      assertEquals(restByName.length, 0);
      assertEquals(byName.node.id, subdir);
      assertEquals(byName.node.type, 'directory');
      assertEquals(byName.childCount, 0);

      assertEquals((await store.getChildLinks(root, { childId: subdir })).map((l) => l.name), ['subdir']);
      assertEquals((await store.getChildLinks(root, { name: 'subdir', childId: subdir })).length, 1);

      // A child of somewhere else, a missing name, and names that are not one level
      assertEquals(await store.getChildLinks(subdir, { childId: subdir }), []);
      assertEquals(await store.getChildLinks(root, { name: 'file1.txt', childId: subdir }), []);
      for (const name of ['nonexistent', '', '.', '..', 'subdir/file2.txt']) {
        assertEquals(await store.getChildLinks(root, { name }), [], name);
      }

      // A listing still counts
      const listed = (await store.getChildren(root)).find((c) => c.name === 'subdir');
      assertEquals(listed?.childCount, 2);
    });

    await t.step('children - list directory contents', async () => {
      const childEntries = await vfs.children(ADMIN_ACCESS, '/');
      assertEquals(childEntries.length, 2);

      const names = childEntries.map((c) => c.name).sort();
      assertEquals(names, ['file1.txt', 'subdir']);
    });

    await t.step('create - new file', async () => {
      const newFile = await vfs.create(ADMIN_ACCESS, 'file', '/', 'newfile.txt', {
        props: { mode: 0o644, uid: 0, gid: 0 },
      });

      assertEquals(newFile.type, 'file');

      // Verify it exists on disk
      const stat = await Deno.lstat(join(testDir, 'newfile.txt'));
      assertEquals(stat.isFile, true);
    });

    await t.step('create - new directory', async () => {
      const newDir = await vfs.create(ADMIN_ACCESS, 'directory', '/', 'newdir', {
        props: { mode: 0o755, uid: 0, gid: 0 },
      });

      assertEquals(newDir.type, 'directory');

      // Verify it exists on disk
      const stat = await Deno.lstat(join(testDir, 'newdir'));
      assertEquals(stat.isDirectory, true);
    });

    await t.step('create - symlink', async () => {
      const newLink = await vfs.create(ADMIN_ACCESS, 'softlink', '/subdir', 'newlink', {
        props: { mode: 0o777, uid: 0, gid: 0, softlink: '../file1.txt' },
      });

      assertEquals(newLink.type, 'softlink');
      assertEquals(newLink.props.softlink, '../file1.txt');
    });

    await t.step('delete - file', async () => {
      await vfs.unlink(ADMIN_ACCESS, '/newfile.txt', '/');

      // Verify it's gone
      await assertRejects(
        () => Deno.lstat(join(testDir, 'newfile.txt')),
        Deno.errors.NotFound,
      );
    });

    await t.step('open and read file', async () => {
      const handle = await vfs.open(ADMIN_ACCESS, '/subdir/file2.txt', { mode: 'r' });

      const text = await toText(handle.readable);
      assertEquals(text, 'Nested file');
    });

    await t.step('rename through the VFS moves the file and gives it its new id', async () => {
      await Deno.writeTextFile(join(testDir, 'before.txt'), 'a sailboat');
      const oldId = (await vfs.resolvePath(ADMIN_ACCESS, '/before.txt')).id;

      const moved = await vfs.rename(ADMIN_ACCESS, '/', 'before.txt', '/subdir', 'after.txt');

      assertEquals(await Deno.readTextFile(join(testDir, 'subdir', 'after.txt')), 'a sailboat');
      assertEquals(moved.id, (await vfs.resolvePath(ADMIN_ACCESS, '/subdir/after.txt')).id);
      assertEquals(moved.id === oldId, false);
    });

    await t.step('rename onto a taken name replaces the file on disk', async () => {
      await Deno.writeTextFile(join(testDir, 'newer.txt'), 'newer');
      await Deno.writeTextFile(join(testDir, 'subdir', 'older.txt'), 'older');

      await vfs.rename(ADMIN_ACCESS, '/', 'newer.txt', '/subdir', 'older.txt');

      assertEquals(await Deno.readTextFile(join(testDir, 'subdir', 'older.txt')), 'newer');
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/newer.txt'), false);
    });

    await t.step('write through the VFS lands on disk', async () => {
      await vfs.create(ADMIN_ACCESS, 'file', '/', 'written.txt', { props: { mode: 0o644, uid: 0, gid: 0 } });
      const handle = await vfs.open(ADMIN_ACCESS, '/written.txt', { mode: 'w' });
      await handle.write(new TextEncoder().encode('a lighthouse'));
      await handle.close();
      assertEquals(await Deno.readTextFile(join(testDir, 'written.txt')), 'a lighthouse');
    });

    await t.step('external renames give the node a new identity', async () => {
      // Ids are derived from the relative path, so a rename outside the VFS
      // invalidates the old id/path and the new path gets a new id.
      await Deno.writeTextFile(join(testDir, 'to-rename.txt'), 'will rename');

      const entry = await vfs.resolvePath(ADMIN_ACCESS, '/to-rename.txt');
      const originalId = entry.id;

      // Rename it on disk (outside of VFS)
      await Deno.rename(join(testDir, 'to-rename.txt'), join(testDir, 'renamed.txt'));

      // The old path and id no longer resolve
      await assertRejects(
        () => vfs.resolvePath(ADMIN_ACCESS, '/to-rename.txt'),
        NodeNotFoundError,
      );
      await assertRejects(() => store.getNode(originalId), NodeNotFoundError);

      // The new path resolves with a different id
      const renamedEntry = await vfs.resolvePath(ADMIN_ACCESS, '/renamed.txt');
      assertEquals(renamedEntry.id === originalId, false);
    });
  } finally {
    await vfs.dispose();
    await routerManager.dispose();
    await Deno.remove(testDir, { recursive: true });
  }
});

Deno.test('FilesystemStore resolveChain walks a path with one lstat per level', async (t) => {
  const dir = await Deno.makeTempDir({ prefix: 'filesystem-store-chain-' });
  await Deno.mkdir(join(dir, 'a', 'b'), { recursive: true });
  await Deno.writeTextFile(join(dir, 'a', 'b', 'f.txt'), 'x');
  await Deno.symlink('../a', join(dir, 'a', 'up'));

  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();
  const store = new FilesystemStore({ rootPath: dir });
  const vfs = new LocalNodeVFS(store, routerManager, { file: new DiskFileRegistry({ rootPath: dir }) });

  const names = async (segments: string[]) => (await store.resolveChain(store.rootId, segments)).entries.map((e) => e.name);

  try {
    await vfs.initialize();

    await t.step('every level, with the ids and props a lookup by name gives', async () => {
      const chain = await store.resolveChain(store.rootId, ['a', 'b', 'f.txt']);
      assertEquals(chain.root.id, store.rootId);
      assertEquals(chain.entries.map((e) => e.name), ['a', 'b', 'f.txt']);
      const [file] = await store.getChildren(chain.entries[1].id, { name: 'f.txt' });
      assertEquals(chain.entries[2].id, file.node.id);
      assertEquals(chain.entries[2].props.mode, file.node.props.mode);
    });

    await t.step('ends at a missing name, below a file, and at a name that is not one level', async () => {
      assertEquals(await names(['a', 'nope', 'b']), ['a']);
      assertEquals(await names(['a', 'b', 'f.txt', 'below']), ['a', 'b', 'f.txt']);
      assertEquals(await names(['a', '..', 'a']), ['a']);
    });

    await t.step('ends right after a softlink, which the VFS then follows itself', async () => {
      const chain = await store.resolveChain(store.rootId, ['a', 'up', 'b', 'f.txt']);
      assertEquals(chain.entries.map((e) => e.name), ['a', 'up']);
      assertEquals(chain.entries[1].props.softlink, '../a');
      assertEquals((await vfs.resolvePath(ADMIN_ACCESS, '/a/up/b/f.txt')).absPath, '/a/b/f.txt');
    });
  } finally {
    await vfs.dispose();
    await routerManager.dispose();
    await Deno.remove(dir, { recursive: true });
  }
});
