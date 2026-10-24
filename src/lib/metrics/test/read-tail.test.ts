/**
 * readTail's window boundary.
 *
 * The window ends at the newest entry. Being a tick stale is invisible on a
 * CPU gauge and fatal for anything that only exists in the latest sample, such
 * as crawl coverage.
 */

import { LOGS_PATH } from '../../paths.ts';
import { assertEquals } from '@std/assert';
import { readTail } from '../read.ts';
import { createTestVfs } from '../../../testing/mod.ts';
import type { NodeVFS } from '../../../vfs/node-vfs.ts';
import { ADMIN_ACCESS } from '../../access/mod.ts';

/** A log node holding `count` entries, numbered so order is checkable. */
const seed = async (vfs: NodeVFS, count: number) => {
  await vfs.create(ADMIN_ACCESS, 'directory', '/', 'logs');
  let parent = '/';
  for (const segment of LOGS_PATH.split('/').filter(Boolean)) {
    await vfs.create(ADMIN_ACCESS, 'directory', parent, segment, {});
    parent = parent === '/' ? `/${segment}` : `${parent}/${segment}`;
  }
  await vfs.create(ADMIN_ACCESS, 'log', LOGS_PATH, 'series');

  const handle = await vfs.open(ADMIN_ACCESS, `${LOGS_PATH}/series`, { mode: 'a' }) as unknown as {
    appendAt(data: unknown, createdAt?: Date): Promise<number>;
    close(): Promise<void>;
  };
  try {
    for (let i = 1; i <= count; i++) await handle.appendAt({ n: i });
  } finally {
    await handle.close();
  }
};

Deno.test('readTail: the window ends at the newest entry', async () => {
  const ctx = await createTestVfs();
  try {
    await seed(ctx.vfs, 20);

    const window = await readTail<{ n: number }>(ctx.vfs, ADMIN_ACCESS, `${LOGS_PATH}/series`, 5);

    assertEquals(window.length, 5);
    // Oldest first, and the last one is the last thing written — not the one
    // before it.
    assertEquals(window.map((sample) => sample.value.n), [16, 17, 18, 19, 20]);
  } finally {
    await ctx.dispose();
  }
});

Deno.test('readTail: a log shorter than the window is returned whole', async () => {
  const ctx = await createTestVfs();
  try {
    await seed(ctx.vfs, 3);

    const window = await readTail<{ n: number }>(ctx.vfs, ADMIN_ACCESS, `${LOGS_PATH}/series`, 10);
    assertEquals(window.map((sample) => sample.value.n), [1, 2, 3]);
  } finally {
    await ctx.dispose();
  }
});

Deno.test('readTail: a missing log is an empty series, not a failure', async () => {
  const ctx = await createTestVfs();
  try {
    assertEquals(await readTail(ctx.vfs, ADMIN_ACCESS, `${LOGS_PATH}/nope`, 10), []);
  } finally {
    await ctx.dispose();
  }
});
