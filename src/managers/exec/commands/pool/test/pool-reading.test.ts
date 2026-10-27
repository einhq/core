import { assertEquals, assertRejects } from '@std/assert';
import type { Access } from '../../../../../lib/access/mod.ts';
import type { PoolStat } from '../../../../../registries/pool/mod.ts';
import type { NodeVFS } from '../../../../../vfs/mod.ts';
import { READING_MAX_AGE_MS, readPoolStat } from '../pool-reading.ts';

const OUTSIDER: Access = { uid: 1000, gids: [1000] } as Access;

/** A VFS whose stat counts its calls, and which refuses `OUTSIDER`. */
const countingVfs = () => {
  let stats = 0;
  const vfs = {
    get: (access: Access) => access === OUTSIDER ? Promise.reject(new Error('permission denied')) : Promise.resolve({}),
    stat: () => Promise.resolve({ size: ++stats } as unknown as PoolStat),
  } as unknown as NodeVFS;
  return { vfs, stats: () => stats };
};

const reader = { uid: 0, gids: [0] } as Access;

Deno.test('readPoolStat: readers share one reading until it is older than the max age', async () => {
  const { vfs, stats } = countingVfs();
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const [a, b] = await Promise.all([readPoolStat(vfs, reader, '/p'), readPoolStat(vfs, reader, '/p')]);
    assertEquals([a.size, b.size, stats()], [1, 1, 1]);

    now += READING_MAX_AGE_MS - 1;
    assertEquals((await readPoolStat(vfs, reader, '/p')).size, 1);

    now += 1;
    assertEquals((await readPoolStat(vfs, reader, '/p')).size, 2);
    assertEquals((await readPoolStat(vfs, reader, '/q')).size, 3, 'each path is its own reading');
  } finally {
    Date.now = realNow;
  }
});

Deno.test('readPoolStat: a caller who may not read the pool gets no shared reading', async () => {
  const { vfs, stats } = countingVfs();
  await readPoolStat(vfs, reader, '/p');

  await assertRejects(() => readPoolStat(vfs, OUTSIDER, '/p'), Error, 'permission denied');
  assertEquals(stats(), 1);
});

Deno.test('readPoolStat: a failed reading is not kept', async () => {
  let calls = 0;
  const vfs = {
    get: () => Promise.resolve({}),
    stat: () => ++calls === 1 ? Promise.reject(new Error('not a pool')) : Promise.resolve({ size: 7 } as unknown as PoolStat),
  } as unknown as NodeVFS;

  await assertRejects(() => readPoolStat(vfs, reader, '/p'), Error, 'not a pool');
  assertEquals((await readPoolStat(vfs, reader, '/p')).size, 7);
});
