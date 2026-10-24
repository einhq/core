/**
 * Label/tag tests: attrs.labels + tag softlink dirs, guard cleanup, prune.
 */

import { TAGS_ROOT } from '../../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { createTestContext, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 3000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

Deno.test({
  name: 'labels',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await client.exec('mkdir -p /scratch/x && mkdir -p /scratch/y');
    await client.exec('echo hello > /scratch/x/photo.txt && echo hi > /scratch/y/photo.txt');

    await t.step('add stores attrs.labels and creates tag links', async () => {
      await cmd.shouldSucceed('label add /scratch/x/photo.txt vacation beach');

      const labels = await client.execJson<string[]>('label list /scratch/x/photo.txt');
      assertEquals(labels, ['vacation', 'beach']);

      const out = await client.execString(`ls ${TAGS_ROOT}/vacation`);
      assertEquals(out.includes('photo.txt'), true, out);
      await cmd.shouldFail('stat /tags');
    });

    await t.step('same name from different dirs gets a suffixed link', async () => {
      await cmd.shouldSucceed('label add /scratch/y/photo.txt vacation');

      const out = await client.execString(`ls ${TAGS_ROOT}/vacation`);
      assertEquals(out.includes('photo.txt-2'), true, out);
    });

    await t.step('add is idempotent', async () => {
      await cmd.shouldSucceed('label add /scratch/x/photo.txt vacation');
      const labels = await client.execJson<string[]>('label list /scratch/x/photo.txt');
      assertEquals(labels, ['vacation', 'beach']);
    });

    await t.step('labels lists the global registry with counts', async () => {
      const all = await client.execJson<{ label: string; count: number }[]>('labels');
      const vacation = all.find((e) => e.label === 'vacation');
      assertEquals(vacation?.count, 2);
    });

    await t.step('remove drops attr and tag link', async () => {
      await cmd.shouldSucceed('label remove /scratch/x/photo.txt beach');
      const labels = await client.execJson<string[]>('label list /scratch/x/photo.txt');
      assertEquals(labels, ['vacation']);

      const out = await client.execString(`ls ${TAGS_ROOT}/beach`);
      assertEquals(out.includes('photo.txt'), false, out);
    });

    await t.step('a label with no members left is not listed', async () => {
      const all = await client.execJson<{ label: string; count: number }[]>('label list');
      assertEquals(all.some((e) => e.label === 'beach'), false);
      assertEquals(all.some((e) => e.label === 'vacation'), true);
    });

    await t.step('add and remove answer the labels left on the node', async () => {
      const added = await client.execJson<{ ok: boolean; labels: string[] }>('label add /scratch/x/photo.txt sunset');
      assertEquals(added.labels, ['vacation', 'sunset']);
      const removed = await client.execJson<{ ok: boolean; labels: string[] }>('label remove /scratch/x/photo.txt sunset');
      assertEquals(removed.labels, ['vacation']);
    });

    await t.step('guard removes tag links when a labeled node is deleted', async () => {
      await cmd.shouldSucceed('rm /scratch/y/photo.txt');

      const gone = await waitFor(async () => {
        const out = await client.execString(`ls ${TAGS_ROOT}/vacation`);
        return !out.includes('photo.txt-2');
      });
      assertEquals(gone, true, 'tag link was not cleaned up by the guard');
    });

    await t.step('prune sweeps dangling links', async () => {
      // A labeled node deleted where the guard cannot see it: its labels attr is
      // cleared first, so the guard skips it and leaves a dangling link.
      await client.exec('echo tmp > /scratch/x/tmp.txt');
      await cmd.shouldSucceed('label add /scratch/x/tmp.txt misc');
      await testCtx.context.vfs.update(ADMIN_ACCESS, '/scratch/x/tmp.txt', { attrs: { labels: [] } });
      await client.exec('rm /scratch/x/tmp.txt');

      const out = await client.execJson<{ ok: boolean; pruned: number }>('label prune');
      assertEquals(out.ok, true);
      assertEquals(out.pruned >= 1, true, JSON.stringify(out));
      const links = await client.execString(`ls ${TAGS_ROOT}/misc`);
      assertEquals(links.includes('tmp.txt'), false, links);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
