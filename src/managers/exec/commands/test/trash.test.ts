/**
 * `trash`: put moves nodes into $HOME/.trash, alone or as one batch, restore moves them back, empty
 * removes them for good.
 */

import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import type { TrashEntry, TrashPutResult, TrashRestoreResult } from '../../../../lib/api/mod.ts';
import { createTestContext, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });

const TRASH = '/home/admin/.trash';

Deno.test({ name: 'trash', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await client.exec('mkdir -p /scratch && echo one > /scratch/one.txt && echo two > /scratch/two.txt');

    let entries: TrashEntry[] = [];
    await t.step('put moves each node into the trash and says where', async () => {
      ({ entries } = await client.execJson<TrashPutResult>('trash put /scratch/one.txt /scratch/two.txt'));
      assertEquals(entries.map((entry) => entry.origPath).sort(), ['/scratch/one.txt', '/scratch/two.txt']);
      await cmd.shouldFail('stat /scratch/one.txt');
      assertEquals(await client.execString(`cat ${entries[0].path}`), entries[0].origPath === '/scratch/one.txt' ? 'one\n' : 'two\n');
    });

    await t.step('list answers the entries, newest first', async () => {
      const listed = await client.execJson<TrashEntry[]>('trash list');
      assertEquals(listed.length, 2);
      assertEquals(listed.every((entry) => entry.path.startsWith('/home/admin/.trash/')), true);
    });

    await t.step('restore puts an entry back, beside a newcomer under a numbered name', async () => {
      const one = entries.find((entry) => entry.origPath === '/scratch/one.txt')!;
      const two = entries.find((entry) => entry.origPath === '/scratch/two.txt')!;
      const back = await client.execJson<TrashRestoreResult>(`trash restore ${one.id}`);
      assertEquals(back.restored, [{ id: one.id, path: '/scratch/one.txt' }]);
      assertEquals(await client.execString('cat /scratch/one.txt'), 'one\n');

      await client.exec('echo newcomer > /scratch/two.txt');
      const beside = await client.execJson<TrashRestoreResult>(`trash restore ${two.id}`);
      assertEquals(beside.restored, [{ id: two.id, path: '/scratch/two (2).txt' }]);
      assertEquals(await client.execJson<TrashEntry[]>('trash list'), []);
    });

    await t.step('restore, put and empty refuse what they cannot do, changing nothing', async () => {
      await cmd.shouldFail('trash restore no-such-entry');
      await cmd.shouldFail('trash put /scratch/missing.txt');
      await cmd.shouldFail('trash put');
      const before = await client.execJson<TrashEntry[]>('trash list');
      await cmd.shouldFailWith('trash empty --help', 'unknown flag --help');
      assertEquals(await client.execJson<TrashEntry[]>('trash list'), before);
    });

    await t.step('a plain put moves up to 2,000 paths and refuses more', async () => {
      await client.exec('mkdir -p /scratch/many');
      const paths = Array.from({ length: 2_001 }, (_, i) => `/scratch/many/f-${String(i).padStart(4, '0')}`);
      await vfs.createTree(ADMIN_ACCESS, '/scratch/many', paths.map((path) => ({ type: 'directory', name: path.slice('/scratch/many/'.length) })));
      await cmd.shouldFailWith(`trash put ${paths.join(' ')}`, 'at most 2000 paths');
      assertEquals(await vfs.exists(ADMIN_ACCESS, paths[0]), true);
      assertEquals(await client.execJson<TrashEntry[]>('trash list'), []);
      const { entries: made } = await client.execJson<TrashPutResult>(`trash put ${paths.slice(1).join(' ')}`);
      assertEquals(made.length, 2_000);
      assertEquals((await client.execJson<{ removed: number }>('trash empty')).removed, 2_000);
      await client.exec('rm -r /scratch/many');
    });

    await t.step('empty removes entries, the old ones only with --older-than', async () => {
      await client.execJson<TrashPutResult>('trash put /scratch/one.txt');
      assertEquals((await client.execJson<{ removed: number }>('trash empty --older-than 1')).removed, 0);
      assertEquals((await client.execJson<{ removed: number }>('trash empty --all --older-than 0')).removed, 1);
      assertEquals(await client.execJson<TrashEntry[]>('trash list'), []);
    });
    let batch = '';
    await t.step('put --batch files every target under one batch, listed as one row', async () => {
      await client.exec('mkdir -p /scratch/b && echo a > /scratch/b/a.txt && echo b > /scratch/b/b.txt && echo c > /scratch/b/c.txt');
      const put = await client.execJson<TrashPutResult>("trash put --batch --label 'Copies of a sailboat' /scratch/b/a.txt /scratch/b/b.txt /scratch/b/c.txt");
      batch = put.batch!;
      assert(batch);
      assertEquals(put.entries.length, 3);
      assert(put.entries.every((entry) => entry.id.startsWith(`${batch}/`) && entry.path.startsWith(`${TRASH}/${batch}/`)));
      assertEquals((await vfs.get(ADMIN_ACCESS, `${TRASH}/${batch}`)).attrs.batch, true);

      const listed = await client.execJson<TrashEntry[]>('trash list');
      assertEquals(listed.length, 1);
      assertEquals({ ...listed[0], trashedAt: '' }, {
        id: batch,
        name: 'Copies of a sailboat',
        origPath: '',
        path: `${TRASH}/${batch}`,
        trashedAt: '',
        type: 'batch',
        count: 3,
        label: 'Copies of a sailboat',
      });
    });

    await t.step('a node in a batch has no path to an id lookup', async () => {
      const node = await vfs.get(ADMIN_ACCESS, `${TRASH}/${batch}`);
      const [entry] = await vfs.children(ADMIN_ACCESS, `${TRASH}/${batch}`);
      const [inside] = await vfs.children(ADMIN_ACCESS, `${TRASH}/${batch}/${entry.name}`);
      assertEquals((await vfs.resolveIdPaths(ADMIN_ACCESS, [inside.node.id, node.id])).size, 0);
      assertEquals(await vfs.resolveId(ADMIN_ACCESS, inside.node.id), []);
    });

    await t.step('restore --limit takes part of a batch and says how much is left', async () => {
      await client.exec('echo newcomer > /scratch/b/a.txt');
      const first = await client.execJson<TrashRestoreResult>(`trash restore ${batch} --limit 2`);
      assertEquals(first.remaining, 1);
      assertEquals(first.restored.map((entry) => entry.path), ['/scratch/b/a (2).txt', '/scratch/b/b.txt']);
      assertEquals(await client.execString("cat '/scratch/b/a (2).txt'"), 'a\n');
      assertEquals(await client.execString('cat /scratch/b/a.txt'), 'newcomer\n');
      assertEquals((await client.execJson<TrashEntry[]>('trash list'))[0].count, 1);

      const rest = await client.execJson<TrashRestoreResult>(`trash restore ${batch}`);
      assertEquals(rest.remaining, 0);
      assertEquals(rest.restored.map((entry) => entry.path), ['/scratch/b/c.txt']);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${TRASH}/${batch}`), false);
      assertEquals(await client.execJson<TrashEntry[]>('trash list'), []);
    });

    await t.step('restore takes one entry of a batch by <batch>/<entry>', async () => {
      const put = await client.execJson<TrashPutResult>('trash put --batch /scratch/b/b.txt /scratch/b/c.txt');
      const back = await client.execJson<TrashRestoreResult>(`trash restore ${put.entries[0].id}`);
      assertEquals(back.restored, [{ id: put.entries[0].id, path: '/scratch/b/b.txt' }]);
      assertEquals(back.remaining, 1);
      await cmd.shouldFail(`trash restore ${put.batch}/no-such-entry`);
      await cmd.shouldFail(`trash restore ${put.batch}/../${put.batch}`);
      await client.execJson<TrashRestoreResult>(`trash restore ${put.batch}`);
      assertEquals(await client.execJson<TrashEntry[]>('trash list'), []);
    });

    await t.step('a batch takes entries up to 2,000 and refuses more', async () => {
      const put = await client.execJson<TrashPutResult>('trash put --batch /scratch/b/b.txt');
      const id = put.batch!;
      const filler = Array.from({ length: 1_998 }, (_, i) => ({ type: 'directory', name: `filler-${String(i).padStart(4, '0')}` }));
      await vfs.createTree(ADMIN_ACCESS, `${TRASH}/${id}`, filler);
      await cmd.shouldFail(`trash put --batch ${id} /scratch/b/c.txt /scratch/b/a.txt`);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/scratch/b/a.txt'), true);
      const more = await client.execJson<TrashPutResult>(`trash put --batch ${id} /scratch/b/c.txt`);
      assertEquals(more.batch, id);
      assertEquals((await client.execJson<TrashEntry[]>('trash list'))[0].count, 2_000);
      await cmd.shouldFail(`trash put --batch ${id} /scratch/b/a.txt`);
    });

    await t.step('empty removes a batch like an entry', async () => {
      assertEquals((await client.execJson<{ removed: number }>('trash empty')).removed, 1);
      assertEquals(await client.execJson<TrashEntry[]>('trash list'), []);
      await cmd.shouldFail('stat /scratch/b/c.txt');
    });

    await t.step('put refuses a label without a batch and a batch id that names an entry', async () => {
      await cmd.shouldFail('trash put --label stray /scratch/b/a.txt');
      const { entries: [entry] } = await client.execJson<TrashPutResult>('trash put /scratch/b/a.txt');
      await client.exec('echo d > /scratch/b/d.txt');
      await cmd.shouldFail(`trash put --batch ${entry.id} /scratch/b/d.txt`);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/scratch/b/d.txt'), true);
      await client.execJson<TrashRestoreResult>(`trash restore ${entry.id}`);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
