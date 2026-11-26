/**
 * PG tier: a node created under a file is the file's owner's, at any depth, whoever creates it,
 * with the ancestors read from PgStore's hierarchy. Gated by EIN_TEST_PG.
 */

import { assertEquals } from '@std/assert';
import { type Access, ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { RouterManager } from '../../../managers/router/mod.ts';
import { pgTest, pgTestContext } from '../../../testing/gates.ts';
import { LocalNodeVFS } from '../../../vfs/mod.ts';
import { PgStore } from '../index.ts';

const OWNER: Access = { uid: 5000, gid: 5000, gids: [5000] };

pgTest("PgStore: what is made under a file is its owner's", async () => {
  const ctx = pgTestContext();
  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();

  const store = new PgStore({ pgPool: ctx.pool, name: ctx.prefix });
  const vfs = new LocalNodeVFS(store, routerManager, {});
  await vfs.initialize();

  try {
    await vfs.create(ADMIN_ACCESS, 'directory', '/', 'inbox', { props: { mode: 0o777 } });
    await vfs.create(OWNER, 'file', '/inbox', 'photo.jpg', { props: { mode: 0o770, gid: 0 } });

    const thumbnails = await vfs.create(ADMIN_ACCESS, 'directory', '/inbox/photo.jpg', 'thumbnails');
    const rendition = await vfs.create(ADMIN_ACCESS, 'file', '/inbox/photo.jpg/thumbnails', '320x320.avif');
    assertEquals([thumbnails.props.uid, rendition.props.uid], [OWNER.uid, OWNER.uid]);

    // One createTree, its levels made before any is committed.
    const [metadata] = await vfs.createTree(ADMIN_ACCESS, '/inbox/photo.jpg', [{ type: 'directory', name: 'metadata', children: [{ type: 'directory', name: 'exif' }] }]);
    const exif = await vfs.get(ADMIN_ACCESS, '/inbox/photo.jpg/metadata/exif');
    assertEquals([metadata.props.uid, exif.props.uid], [OWNER.uid, OWNER.uid]);

    // Beside the file, a node stays its creator's.
    const beside = await vfs.create(ADMIN_ACCESS, 'directory', '/inbox', 'other');
    assertEquals(beside.props.uid, ADMIN_ACCESS.uid);
  } finally {
    await vfs.dispose();
    await routerManager.dispose();
    await ctx.teardown();
  }
});
