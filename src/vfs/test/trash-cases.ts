import { assert, assertEquals } from '@std/assert';
import type { Access } from '../../lib/access/mod.ts';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { isTrashPath } from '../../lib/paths.ts';
import type { NodeVFS } from '../mod.ts';
import { mkdir } from './helpers.ts';

const OWNER: Access = { uid: 5000, gid: 5000, gids: [5000] };

/**
 * A node moved into a user's trash keeps its id and has no path for anyone — admin included — to
 * id lookups, attr queries and `resolveId`, so every list built on them drops it; its trash path
 * still opens directly, and moving it back gives it its path again.
 */
export async function trashCases(vfs: NodeVFS, step: (name: string, fn: () => Promise<void>) => Promise<unknown>): Promise<void> {
  await mkdir(vfs, ADMIN_ACCESS, '/', 'home', 0o755);
  await mkdir(vfs, ADMIN_ACCESS, '/home', 'owner', 0o755);
  await vfs.update(ADMIN_ACCESS, '/home/owner', { props: { uid: OWNER.uid, gid: OWNER.gid } });
  await mkdir(vfs, OWNER, '/home/owner', '.trash', 0o700);
  await mkdir(vfs, OWNER, '/home/owner/.trash', 'entry', 0o700);
  await mkdir(vfs, ADMIN_ACCESS, '/', 'pictures', 0o777);
  const photo = await vfs.create(OWNER, 'file', '/pictures', 'p.jpg', { props: { mode: 0o664 }, attrs: { name: 'p.jpg', mark: 'trash-case' } });
  const query = { types: ['file'], where: [{ ref: 'mark', op: 'eq' as const, value: 'trash-case' }], limit: 10 };

  await step('a live file has its path', async () => {
    assertEquals((await vfs.resolveIdPaths(ADMIN_ACCESS, [photo.id])).get(photo.id), ['/pictures/p.jpg']);
    assertEquals((await vfs.query(ADMIN_ACCESS, query)).map((entry) => entry.absPath), ['/pictures/p.jpg']);
  });

  await vfs.rename(OWNER, '/pictures', 'p.jpg', '/home/owner/.trash/entry', 'p.jpg', { failIfExists: true });

  await step('a trashed file has no path for anyone, and drops out of queries', async () => {
    for (const access of [ADMIN_ACCESS, OWNER]) {
      assertEquals((await vfs.resolveIdPaths(access, [photo.id])).get(photo.id), undefined);
      assertEquals(await vfs.query(access, query), []);
      assertEquals(await vfs.resolveId(access, photo.id), []);
    }
  });

  await step('its trash path still opens, and the node is the same one', async () => {
    const node = await vfs.get(OWNER, '/home/owner/.trash/entry/p.jpg');
    assertEquals(node.id, photo.id);
  });

  await vfs.rename(OWNER, '/home/owner/.trash/entry', 'p.jpg', '/pictures', 'p.jpg', { failIfExists: true });

  await step('restored, it has its path again', async () => {
    assertEquals((await vfs.resolveIdPaths(ADMIN_ACCESS, [photo.id])).get(photo.id), ['/pictures/p.jpg']);
    assertEquals((await vfs.query(OWNER, query)).map((entry) => entry.absPath), ['/pictures/p.jpg']);
  });

  await step('which paths count as trash', () => {
    assert(isTrashPath('/home/owner/.trash'));
    assert(isTrashPath('/home/owner/.trash/entry/p.jpg'));
    assert(!isTrashPath('/home/owner/.trashcan/p.jpg'));
    assert(!isTrashPath('/home/.trash/p.jpg'));
    assert(!isTrashPath('/archive/home/owner/.trash/p.jpg'));
    return Promise.resolve();
  });
}
