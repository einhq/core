/**
 * NodeQuery fan-out across mounts.
 *
 * A keyset cursor is a boundary in the global (sort value, node id) order. The
 * same boundary therefore belongs in every contributing store; each store can
 * discard its own rows before it, and the VFS merges the remaining prefixes.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import type { NodeQuery, NodeQueryEntry } from '../mod.ts';

const createFile = async (
  vfs: Awaited<ReturnType<typeof createTestVfs>>['vfs'],
  name: string,
  rank: string,
): Promise<void> => {
  await vfs.create(ADMIN_ACCESS, 'file', '/', name, {
    props: { mode: 0o644 },
    attrs: { rank },
  });
};

const pageToEnd = async (
  vfs: Awaited<ReturnType<typeof createTestVfs>>['vfs'],
  query: Omit<NodeQuery, 'after' | 'limit'>,
  limit: number,
): Promise<NodeQueryEntry[]> => {
  const entries: NodeQueryEntry[] = [];
  let after: NodeQuery['after'];

  for (let guard = 0; guard < 100; guard++) {
    const page = await vfs.query(ADMIN_ACCESS, { ...query, after, limit });
    if (page.length === 0) return entries;
    entries.push(...page);
    const last = page[page.length - 1];
    after = { value: last.sortValue, id: last.id };
  }

  throw new Error('query paging did not terminate');
};

Deno.test('VFS query keyset paging across mounts', async (t) => {
  const outer = await createTestVfs();
  const first = await createTestVfs();
  const second = await createTestVfs();

  await outer.vfs.create(ADMIN_ACCESS, 'directory', '/', 'first', { props: { mode: 0o755 } });
  await outer.vfs.create(ADMIN_ACCESS, 'directory', '/', 'second', { props: { mode: 0o755 } });

  // Values interleave all three stores. The repeated rank also makes the node
  // id tie-break cross a mount boundary instead of merely testing distinct
  // sort values.
  await createFile(outer.vfs, 'local-2', '2');
  await createFile(outer.vfs, 'local-5', '5');
  await createFile(first.vfs, 'first-1', '1');
  await createFile(first.vfs, 'first-3', '3');
  await createFile(second.vfs, 'second-3', '3');
  await createFile(second.vfs, 'second-4', '4');
  await createFile(second.vfs, 'second-6', '6');

  await outer.vfs.mount(ADMIN_ACCESS, '/first', first.vfs);
  await outer.vfs.mount(ADMIN_ACCESS, '/second', second.vfs);

  try {
    const cases: { name: string; query: Omit<NodeQuery, 'after' | 'limit'> }[] = [
      { name: 'ascending attr order', query: { types: ['file'], orderBy: { ref: 'rank', dir: 'asc' } } },
      { name: 'descending attr order', query: { types: ['file'], orderBy: { ref: 'rank', dir: 'desc' } } },
      { name: 'default id order', query: { types: ['file'] } },
    ];

    for (const { name, query } of cases) {
      await t.step(name, async () => {
        const all = await outer.vfs.query(ADMIN_ACCESS, { ...query, limit: 100 });
        const expected = all.map((entry) => entry.absPath);

        for (const limit of [1, 2, 3]) {
          const paged = await pageToEnd(outer.vfs, query, limit);
          const paths = paged.map((entry) => entry.absPath);
          assertEquals(paths, expected, `page size ${limit}`);
          assertEquals(new Set(paths).size, paths.length, `page size ${limit} repeated a row`);
        }
      });
    }
  } finally {
    await outer.vfs.unmount(ADMIN_ACCESS, '/first');
    await outer.vfs.unmount(ADMIN_ACCESS, '/second');
    await outer.dispose();
    await first.dispose();
    await second.dispose();
  }
});
