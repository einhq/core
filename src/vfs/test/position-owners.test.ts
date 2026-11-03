/**
 * A position's owners are the types of the nodes it is a child of, and a geo search's
 * `ownerTypes` filter keeps the positions with an owner of one of them. They follow every change
 * of a position's parents — create, move, link, unlink, copy — and `initialize` records them for
 * positions stored without.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { RouterManager } from '../../managers/router/mod.ts';
import { MemoryPositionRegistry } from '../../registries/position/mod.ts';
import { InMemoryStore } from '../../stores/memory/index.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { LocalNodeVFS } from '../mod.ts';
import type { NodeVFS } from '../node-vfs.ts';

const enc = new TextEncoder();
const HERE = { lat: 57.7, lng: 11.97 };

const place = async (vfs: NodeVFS, path: string, radius = 100): Promise<void> => {
  const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
  try {
    await handle.write(enc.encode(JSON.stringify({ ...HERE, radius })));
  } finally {
    await handle.close();
  }
};

/** The paths the positions near `HERE` with an owner of `types` resolve to. */
const near = async (vfs: NodeVFS, types?: string[]): Promise<string[]> => {
  const matches = await vfs.findNearby(ADMIN_ACCESS, HERE.lat, HERE.lng, 1000, 10, types ? { ownerTypes: types } : undefined);
  const paths = await vfs.resolveIdPaths(ADMIN_ACCESS, matches.map((match) => match.id));
  return matches.flatMap((match) => paths.get(match.id) ?? []).sort();
};

Deno.test('position owners follow its parents', async (t) => {
  const ctx = await createTestVfs();
  const { vfs } = ctx;

  try {
    await vfs.createTree(ADMIN_ACCESS, '/', [{ type: 'directory', name: 'spot', children: [{ type: 'position', name: 'position' }] }]);
    await vfs.create(ADMIN_ACCESS, 'file', '/', 'photo.jpg', { attrs: { mimetype: 'image/jpeg' } });
    await vfs.create(ADMIN_ACCESS, 'position', '/photo.jpg', 'position');
    await place(vfs, '/spot/position');
    await place(vfs, '/photo.jpg/position');

    await t.step('a created position is owned by its parent', async () => {
      assertEquals(await near(vfs, ['directory']), ['/spot/position']);
      assertEquals(await near(vfs, ['file']), ['/photo.jpg/position']);
      assertEquals(await near(vfs), ['/photo.jpg/position', '/spot/position']);
    });

    await t.step('a filtered search finds the owner beyond the limit of an unfiltered one', async () => {
      const matches = await vfs.findContaining(ADMIN_ACCESS, HERE.lat, HERE.lng, 1, { ownerTypes: ['directory'] });
      assertEquals((await vfs.resolveIdPaths(ADMIN_ACCESS, matches.map((match) => match.id))).get(matches[0].id), ['/spot/position']);
    });

    await t.step('a hard link adds an owner, and unlinking it takes it away', async () => {
      await vfs.link(ADMIN_ACCESS, '/spot/position', '/photo.jpg', 'also');
      assertEquals(await near(vfs, ['file']), ['/photo.jpg/also', '/photo.jpg/position', '/spot/position']);

      await vfs.unlink(ADMIN_ACCESS, '/photo.jpg/also', '/photo.jpg');
      assertEquals(await near(vfs, ['file']), ['/photo.jpg/position']);
    });

    await t.step('a moved position is owned by its new parent', async () => {
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'other');
      await vfs.rename(ADMIN_ACCESS, '/photo.jpg', 'position', '/other', 'position');
      assertEquals(await near(vfs, ['file']), []);
      assertEquals(await near(vfs, ['directory']), ['/other/position', '/spot/position']);
    });

    await t.step('a copied position is owned by the copy of its parent', async () => {
      await vfs.copy(ADMIN_ACCESS, '/photo.jpg', '/', 'copy.jpg');
      await vfs.copy(ADMIN_ACCESS, '/spot/position', '/copy.jpg', 'position');
      await place(vfs, '/copy.jpg/position');
      assertEquals(await near(vfs, ['file']), ['/copy.jpg/position']);
    });
  } finally {
    await ctx.dispose();
  }
});

Deno.test('initialize records the owners of positions stored without them', async () => {
  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();
  const store = new InMemoryStore({});

  // Nodes made while the VFS had no position registry, whose rows then appear without owners.
  const bare = new LocalNodeVFS(store, routerManager, {});
  await bare.initialize();
  const [spot] = await bare.createTree(ADMIN_ACCESS, '/', [{ type: 'directory', name: 'spot', children: [{ type: 'position', name: 'position' }] }]);
  const position = (await store.getChildLinks(spot.id, { name: 'position' }))[0].id;

  const registry = new MemoryPositionRegistry();
  await registry.touch(position, {});
  const handle = await registry.open(position, {}, 'w');
  await handle.write(enc.encode(JSON.stringify(HERE)));
  await handle.close();
  assertEquals(await registry.unowned(10), [position]);

  const vfs = new LocalNodeVFS(store, routerManager, { position: registry });
  try {
    await vfs.initialize();
    assertEquals(await registry.unowned(10), []);
    assertEquals(await near(vfs, ['directory']), ['/spot/position']);
  } finally {
    await vfs.dispose();
    await bare.dispose();
    await routerManager.dispose();
  }
});
