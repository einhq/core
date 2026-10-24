/**
 * SftpStore and SftpFileRegistry through LocalNodeVFS, against an in-process
 * SFTP server (src/testing/ssh-test-server.ts) serving a temp directory.
 */

import { assert, assertEquals, assertRejects } from '@std/assert';
import { join } from '@std/path';
import { toText } from '@std/streams';
import { Client } from 'ssh2';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { SftpConnection } from '../../../lib/ssh/mod.ts';
import { RouterManager } from '../../../managers/router/mod.ts';
import { SftpFileRegistry } from '../../../registries/file/sftp-file-registry.ts';
import { ResourceSeekMode } from '../../../registries/types.ts';
import { startSshTestServer } from '../../../testing/ssh-test-server.ts';
import { LocalNodeVFS, NodeNotFoundError } from '../../../vfs/mod.ts';
import { SftpStore } from '../index.ts';

Deno.test('SftpStore', async (t) => {
  const root = await Deno.makeTempDir({ prefix: 'ein-sftp-store-' });
  await Deno.mkdir(join(root, 'share', 'photos'), { recursive: true });
  await Deno.mkdir(join(root, 'share', 'one'), { recursive: true });
  await Deno.writeTextFile(join(root, 'share', 'notes.txt'), 'a sailboat');
  await Deno.writeTextFile(join(root, 'share', 'photos', 'beach.jpg'), 'not really a jpeg');
  await Deno.writeTextFile(join(root, 'share', 'one', 'only.txt'), 'alone');
  await Deno.symlink('notes.txt', join(root, 'share', 'link'));
  await Deno.writeTextFile(join(root, 'outside.txt'), 'not in the mount');

  const server = await startSshTestServer({ root, password: 'pw' });
  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();

  let connects = 0;
  const conn = new SftpConnection({
    label: `anna@127.0.0.1:share`,
    path: 'share',
    connect: async () => {
      connects++;
      const client = new Client();
      await client.connect({ host: '127.0.0.1', port: server.port, username: 'anna', password: 'pw', hostVerifier: () => true });
      return client;
    },
  });
  const store = new SftpStore({ uid: 1234, gid: 1002 }, conn);
  const vfs = new LocalNodeVFS(store, routerManager, { file: new SftpFileRegistry(conn) });

  try {
    await vfs.initialize();

    await t.step('lists the remote directory, owned by the mount', async () => {
      const entries = await vfs.children(ADMIN_ACCESS, '/');
      assertEquals(entries.map((e) => e.name), ['link', 'notes.txt', 'one', 'photos']);

      const photos = entries.find((e) => e.name === 'photos')!;
      assertEquals(photos.node.type, 'directory');
      assertEquals(photos.childCount, 1);

      const notes = entries.find((e) => e.name === 'notes.txt')!;
      assertEquals(notes.node.type, 'file');
      assertEquals(notes.node.attrs.size, 10);
      assertEquals(notes.node.attrs.mimetype, 'text/plain');
      assertEquals(notes.node.props.uid, 1234);
      assertEquals(notes.node.props.gid, 1002);
    });

    await t.step('a directory with a single entry lists it', async () => {
      const entries = await vfs.children(ADMIN_ACCESS, '/one');
      assertEquals(entries.map((e) => e.name), ['only.txt']);
    });

    await t.step('links are softlinks, followed on request', async () => {
      const link = await vfs.get(ADMIN_ACCESS, '/link', { follow: false });
      assertEquals(link.type, 'softlink');
      assertEquals(link.props.softlink, 'notes.txt');
    });

    await t.step('reads content, and seeks', async () => {
      const handle = await vfs.open(ADMIN_ACCESS, '/notes.txt', { mode: 'r' });
      assertEquals(await toText(handle.readable), 'a sailboat');
      await handle.close();

      const again = await vfs.open(ADMIN_ACCESS, '/notes.txt', { mode: 'r' });
      await again.seek(2, ResourceSeekMode.Start);
      assertEquals(new TextDecoder().decode(await again.read(4)), 'sail');
      await again.close();
    });

    await t.step('a large file streams in and out intact', async () => {
      const data = new Uint8Array(3 * 1024 * 1024 + 17);
      for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 0xff;

      await vfs.create(ADMIN_ACCESS, 'file', '/photos', 'big.bin');
      const out = await vfs.open(ADMIN_ACCESS, '/photos/big.bin', { mode: 'w' });
      await new Blob([data]).stream().pipeTo(out.writable);
      await out.close();

      const onDisk = await Deno.readFile(join(root, 'share', 'photos', 'big.bin'));
      assertEquals(onDisk.length, data.length);
      assertEquals(onDisk, data);

      const back = await vfs.open(ADMIN_ACCESS, '/photos/big.bin', { mode: 'r' });
      const read = new Uint8Array(await new Response(back.readable).arrayBuffer());
      await back.close();
      assertEquals(read, data);
    });

    await t.step('creates directories and files', async () => {
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'new-album');
      await vfs.create(ADMIN_ACCESS, 'file', '/new-album', 'a.txt');
      const handle = await vfs.open(ADMIN_ACCESS, '/new-album/a.txt', { mode: 'w' });
      await handle.write(new TextEncoder().encode('a lighthouse'));
      await handle.close();

      assertEquals(await Deno.readTextFile(join(root, 'share', 'new-album', 'a.txt')), 'a lighthouse');
      assertEquals((await vfs.get(ADMIN_ACCESS, '/new-album/a.txt')).attrs.size, 12);
      // The VFS default mode carries execute bits; a new remote file must not
      assertEquals((await Deno.stat(join(root, 'share', 'new-album', 'a.txt'))).mode! & 0o111, 0);
    });

    await t.step('renames through the VFS, with a new id at the new path', async () => {
      const before = (await vfs.resolvePath(ADMIN_ACCESS, '/new-album/a.txt')).id;
      const moved = await vfs.rename(ADMIN_ACCESS, '/new-album', 'a.txt', '/', 'moved.txt');
      assertEquals(await Deno.readTextFile(join(root, 'share', 'moved.txt')), 'a lighthouse');
      assert(moved.id !== before);
      assertEquals(moved.id, (await vfs.resolvePath(ADMIN_ACCESS, '/moved.txt')).id);
    });

    await t.step('a rename onto an existing file replaces it', async () => {
      await vfs.create(ADMIN_ACCESS, 'file', '/', 'draft.txt');
      const handle = await vfs.open(ADMIN_ACCESS, '/draft.txt', { mode: 'w' });
      await handle.write(new TextEncoder().encode('a rowboat'));
      await handle.close();
      await Deno.writeTextFile(join(root, 'share', 'kept.txt'), 'old text');

      await vfs.rename(ADMIN_ACCESS, '/', 'draft.txt', '/', 'kept.txt');
      assertEquals(await Deno.readTextFile(join(root, 'share', 'kept.txt')), 'a rowboat');
      await assertRejects(() => Deno.lstat(join(root, 'share', 'draft.txt')), Deno.errors.NotFound);
      await vfs.unlink(ADMIN_ACCESS, '/kept.txt', '/');
    });

    await t.step('creates a link, changes a mode, deletes', async () => {
      await vfs.create(ADMIN_ACCESS, 'softlink', '/', 'to-moved', { props: { softlink: 'moved.txt' } });
      assertEquals(await Deno.readLink(join(root, 'share', 'to-moved')), 'moved.txt');

      await vfs.update(ADMIN_ACCESS, '/moved.txt', { props: { mode: 0o600 } });
      assertEquals((await Deno.stat(join(root, 'share', 'moved.txt'))).mode! & 0o777, 0o600);

      // readlink: the link itself, as rm does
      await vfs.unlink(ADMIN_ACCESS, '/to-moved', '/', { readlink: true });
      assertEquals(await Deno.readTextFile(join(root, 'share', 'moved.txt')), 'a lighthouse');
      await vfs.unlink(ADMIN_ACCESS, '/moved.txt', '/');
      await assertRejects(() => Deno.lstat(join(root, 'share', 'moved.txt')), Deno.errors.NotFound);
    });

    await t.step('nothing outside the mounted directory is reachable', async () => {
      await assertRejects(() => vfs.get(ADMIN_ACCESS, '/outside.txt'), NodeNotFoundError);
      await assertRejects(() => vfs.get(ADMIN_ACCESS, '/../outside.txt'), NodeNotFoundError);
    });

    await t.step('ids of other stores are turned away without asking the server', async () => {
      assertEquals(await store.exists('01JABCDEFGHJKMNPQRSTVWXYZ0'), false);
    });

    await t.step('a dropped connection is opened again on use', async () => {
      const before = connects;
      // What a network failure looks like to the mount
      (conn as unknown as { client?: Client }).client?.end();
      await new Promise((r) => setTimeout(r, 50));
      const entries = await vfs.children(ADMIN_ACCESS, '/photos');
      assert(entries.some((e) => e.name === 'beach.jpg'));
      assertEquals(connects, before + 1);
    });
  } finally {
    await vfs.dispose();
    await routerManager.dispose();
    await server.close();
    await Deno.remove(root, { recursive: true });
  }
});
