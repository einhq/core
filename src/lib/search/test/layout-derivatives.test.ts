/**
 * `search --layout --fields derivatives`: each row's file says whether it has renditions (a
 * `thumbnails/` child) in a list beside the rows, for a container and for a subtree; without the
 * field the list is absent. A container of links answers for the files they point at, and the
 * children are read in one `getChildLinksByIds` per 1,000 files.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../access/mod.ts';
import { captureTime, createTestContext, testCommands } from '../../../testing/mod.ts';
import type { SearchLayoutResponse } from '../../api/search.ts';
import type { NodeTreeSpec } from '../../../vfs/types.ts';

const testCtx = createTestContext({ boot: true });

Deno.test({
  name: 'search --layout --fields derivatives',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const mkmedia = async (path: string, takenAt: string) => {
    await cmd.shouldSucceed(`echo x > ${path}`);
    await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype: 'image/jpeg', ...captureTime(takenAt) } });
  };
  const namesAndRenditions = (answer: SearchLayoutResponse) => answer.layout.items.map((row, index) => [row[1], answer.layout.derivatives?.[index]] as const);

  try {
    // One file processed (its renditions are there), one just arrived.
    await cmd.shouldSucceed('mkdir -p /lake-weekend');
    await mkmedia('/lake-weekend/early.jpg', '2019-06-14T09:00:00');
    await mkmedia('/lake-weekend/late.jpg', '2019-06-15T18:00:00');
    await cmd.shouldSucceed('mkdir -p /lake-weekend/early.jpg/thumbnails');

    await t.step('a container says which of its files have renditions', async () => {
      const answer = await client.execJson<SearchLayoutResponse>('search --under /lake-weekend --sort time --layout --fields derivatives');
      assertEquals(answer.truncated, false);
      assertEquals(namesAndRenditions(answer), [['early.jpg', 1], ['late.jpg', 0]]);
    });

    await t.step('so does a subtree', async () => {
      const answer = await client.execJson<SearchLayoutResponse>('search --within /lake-weekend --sort time --layout --fields derivatives');
      assertEquals(namesAndRenditions(answer), [['early.jpg', 1], ['late.jpg', 0]]);
    });

    await t.step('without the field nothing is read for it', async () => {
      const answer = await client.execJson<SearchLayoutResponse>('search --under /lake-weekend --sort time --layout');
      assertEquals(answer.layout.derivatives, undefined);
      assertEquals(answer.layout.items.length, 2);
    });

    await t.step('a group of links answers for the files, reading children once per 1,000 of them', async () => {
      // 1,001 files, every third with renditions, and a group that holds a link to each, as a
      // suggested album holds the staged files it groups.
      const count = 1001;
      const name = (index: number) => `IMG_${String(index).padStart(4, '0')}.jpg`;
      const processed = (index: number) => index % 3 === 0;
      const files: NodeTreeSpec[] = Array.from({ length: count }, (_, index) => ({
        type: 'file',
        name: name(index),
        attrs: { mimetype: 'image/jpeg', ...captureTime(`2019-06-14T${String(8 + Math.floor(index / 120)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00`) },
        ...(processed(index) ? { children: [{ type: 'directory', name: 'thumbnails' }] } : {}),
      }));
      await cmd.shouldSucceed('mkdir -p /inbox/files /inbox/group');
      await vfs.createTree(ADMIN_ACCESS, '/inbox/files', files);
      await vfs.createTree(
        ADMIN_ACCESS,
        '/inbox/group',
        files.map((file) => ({ type: 'softlink', name: file.name, props: { mode: 0o777, softlink: `/inbox/files/${file.name}` } })),
      );

      const batches: number[] = [];
      const read = vfs.getChildLinksByIds.bind(vfs);
      vfs.getChildLinksByIds = (access, ids) => {
        batches.push(ids.length);
        return read(access, ids);
      };
      let answer: SearchLayoutResponse;
      try {
        answer = await client.execJson<SearchLayoutResponse>('search --under /inbox/group --sort time --layout --fields derivatives');
      } finally {
        vfs.getChildLinksByIds = read;
      }

      assertEquals(answer.truncated, false);
      assertEquals(answer.layout.items.length, count);
      assertEquals(batches, [1000, 1]);
      const renditions = new Map(answer.layout.items.map((row, index) => [row[1], answer.layout.derivatives?.[index]]));
      for (let index = 0; index < count; index++) assertEquals(renditions.get(name(index)), processed(index) ? 1 : 0, name(index));
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
