/**
 * `ensureAttrIndexes` reaches a mounted store: the PostgreSQL store is mounted at `/` under a
 * router-only root, whose own store has no index to build.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import type { IndexDecl } from '../../lib/contributions/types.ts';

Deno.test('ensureAttrIndexes reaches the stores mounted below the root', async () => {
  const outer = await createTestVfs();
  const inner = await createTestVfs();
  try {
    await outer.vfs.create(ADMIN_ACCESS, 'directory', '/', 'pg', { props: { mode: 0o755 } });
    await outer.vfs.mount(ADMIN_ACCESS, '/pg', inner.vfs);

    const made: IndexDecl[][] = [];
    (inner.store as { ensureAttrIndexes?: (indexes: IndexDecl[]) => Promise<void> }).ensureAttrIndexes = (indexes) => {
      made.push(indexes);
      return Promise.resolve();
    };

    const indexes: IndexDecl[] = [{ name: 'mime', on: ['mimetype'] }];
    await outer.vfs.ensureAttrIndexes(ADMIN_ACCESS, indexes);
    assertEquals(made, [indexes]);

    // Still an administrator's call, whichever store it lands in.
    await assertRejects(() => outer.vfs.ensureAttrIndexes({ uid: 2001, gid: 2001, gids: [2001] }, indexes));
  } finally {
    await inner.dispose();
    await outer.dispose();
  }
});
