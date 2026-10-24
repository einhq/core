/**
 * PG tier: a trash batch at its cap. `trash put --batch` makes 2,000 entry directories in one
 * `createTree` transaction and moves 2,000 files into them, and the batch restores in two calls of
 * `--limit 1000`, going once it is empty. Gated by EIN_TEST_PG.
 */

import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import type { TrashEntry, TrashPutResult, TrashRestoreResult } from '../../../lib/api/mod.ts';
import type { Command } from '../../../managers/exec/command.ts';
import { trash } from '../../../managers/exec/commands/node/trash.ts';
import { RouterManager } from '../../../managers/router/mod.ts';
import { MemoryFileRegistry } from '../../../registries/file/mod.ts';
import { pgTest, pgTestContext } from '../../../testing/gates.ts';
import { LocalNodeVFS } from '../../../vfs/mod.ts';
import { mkdirp } from '../../../vfs/test/helpers.ts';
import { PgStore } from '../index.ts';

const FILES = 2_000;
const HOME = '/home/admin';
const DIR = '/pictures/sailboat';

/** Run `trash` as the administrator, answering JSON; throws with its stderr when it fails. */
const runTrash = async <T>(vfs: LocalNodeVFS, args: string[]): Promise<T> => {
  let out: unknown;
  let err = '';
  const cmd = {
    sys: { vfs },
    access: ADMIN_ACCESS,
    cwd: '/',
    args,
    env: { HOME },
    json: true,
    writeJSON: (value: unknown) => {
      out = value;
      return Promise.resolve();
    },
    writeLn: () => Promise.resolve(),
    writeError: (text: string) => {
      err += text;
      return Promise.resolve();
    },
  } as unknown as Command;
  const code = await trash(cmd);
  if (code !== 0) throw new Error(err);
  return out as T;
};

pgTest('a trash batch of 2,000 entries is made in one call and restored in two', async (t) => {
  const ctx = pgTestContext();
  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();
  const vfs = new LocalNodeVFS(new PgStore({ pgPool: ctx.pool, name: ctx.prefix }), routerManager, { file: new MemoryFileRegistry() });
  await vfs.initialize();

  try {
    await mkdirp(vfs, ADMIN_ACCESS, HOME);
    await mkdirp(vfs, ADMIN_ACCESS, DIR);
    const names = Array.from({ length: FILES }, (_, i) => `IMG_${String(i).padStart(4, '0')}.jpg`);
    await vfs.createTree(ADMIN_ACCESS, DIR, names.map((name) => ({ type: 'file', name, attrs: { mimetype: 'image/jpeg' } })));

    let batch = '';
    await t.step('put --batch moves 2,000 files into one batch', async () => {
      const put = await runTrash<TrashPutResult>(vfs, ['put', '--batch', ...names.map((name) => `${DIR}/${name}`)]);
      batch = put.batch!;
      assert(batch);
      assertEquals(put.entries.length, FILES);
      assertEquals(await vfs.childCount(ADMIN_ACCESS, DIR), 0);
      const [row] = await runTrash<TrashEntry[]>(vfs, ['list']);
      assertEquals([row.id, row.type, row.count], [batch, 'batch', FILES]);
    });

    await t.step('restore --limit 1000 twice brings every file back and removes the batch', async () => {
      const first = await runTrash<TrashRestoreResult>(vfs, ['restore', batch, '--limit', '1000']);
      assertEquals([first.restored.length, first.remaining], [1_000, 1_000]);
      const second = await runTrash<TrashRestoreResult>(vfs, ['restore', batch, '--limit', '1000']);
      assertEquals([second.restored.length, second.remaining], [1_000, 0]);
      assertEquals(await vfs.childCount(ADMIN_ACCESS, DIR), FILES);
      assertEquals(await runTrash<TrashEntry[]>(vfs, ['list']), []);
    });
  } finally {
    await vfs.dispose();
    await routerManager.dispose();
    await ctx.teardown();
  }
});
