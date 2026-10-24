/**
 * `unzip` expands a nested archive into files with their bytes, size, sha256, mimetype and the
 * entries' time; a run again leaves the files already there and goes on past one it may not write
 * over; an archive with an entry that would land outside the directory is refused before anything
 * is written; and the free space is checked against what the run will write, not against the
 * whole archive. The zips are `fixtures/unzip/`, made by `make.ts` there.
 */

import { assertEquals, assertMatch, assertRejects } from '@std/assert';
import type { UnzipAnswer } from '../../../../lib/api/node.ts';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';
import { NODE_TYPE_FILE } from '../../../../vfs/types/file.ts';
import { expandZip, SPACE_FACTOR, UnzipRefusedError } from '../node/unzip.ts';

const testCtx = createTestContext();

const NESTED_BYTES = 392 + 22 + 16 + 24;

Deno.test({
  name: 'unzip',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const put = async (path: string, bytes: Uint8Array) => {
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      await handle.write(bytes);
    } finally {
      await handle.close();
    }
  };
  const fixture = (name: string) => Deno.readFile(new URL(`fixtures/unzip/${name}`, import.meta.url));
  const expand = (directory: string, opts: { overwrite?: boolean; free?: number } = {}) =>
    expandZip(vfs, ADMIN_ACCESS, '/z/nested.zip', directory, {
      overwrite: opts.overwrite ?? false,
      freeBytes: () => Promise.resolve(opts.free),
    });
  const text = async (path: string) => (await client.execString(`cat '${path}'`)).trim();

  try {
    await cmd.shouldSucceed('mkdir -p /z && mkfile /z/nested.zip && mkfile /z/slip.zip');
    await put('/z/nested.zip', await fixture('nested.zip'));
    await put('/z/slip.zip', await fixture('slip.zip'));

    await t.step('a nested archive is expanded into files with what an upload records', async () => {
      const answer = await client.execJson<UnzipAnswer>('cd /z && unzip -d out nested.zip');

      assertEquals(answer, {
        ok: true,
        archive: '/z/nested.zip',
        directory: '/z/out',
        files: 4,
        // out, Exempelresa, dag-1, karta, dag-2 and the empty tom
        directories: 6,
        bytes: NESTED_BYTES,
        skipped: 0,
        failed: [],
      });
      assertEquals(await text('/z/out/Exempelresa/dag-1/karta/rutt.txt'), 'Från udden till ön.');
      assertEquals(await text('/z/out/lösa-blad.txt'), 'Anna Andersson var med.');
      assertEquals(await client.execJson<unknown[]>('ls /z/out/Exempelresa/dag-2/tom'), []);

      const deflated = await vfs.get(ADMIN_ACCESS, '/z/out/Exempelresa/dag-1/anteckningar.txt');
      assertEquals(deflated.type, NODE_TYPE_FILE);
      assertEquals(deflated.attrs.size, 392);
      assertEquals(deflated.attrs.mimetype, 'text/plain');
      assertMatch(String(deflated.attrs.sha256), /^[0-9a-f]{64}$/);
      assertEquals(deflated.attrs.writtenAt, '2019-07-14T10:30:00.000Z');
    });

    await t.step('a run again leaves the files there and writes only what is missing', async () => {
      await cmd.shouldSucceed('rm /z/out/Exempelresa/dag-1/karta/rutt.txt');

      const answer = await client.execJson<UnzipAnswer>('unzip -n -d /z/out /z/nested.zip');

      assertEquals({ files: answer.files, skipped: answer.skipped, directories: answer.directories, ok: answer.ok }, {
        files: 1,
        skipped: 3,
        directories: 0,
        ok: true,
      });
      assertEquals(await text('/z/out/Exempelresa/dag-1/karta/rutt.txt'), 'Från udden till ön.');
    });

    await t.step('a file of another size is not written over, and the rest are still expanded', async () => {
      await cmd.shouldSucceed('echo "a longer note someone else wrote here" > /z/out/lösa-blad.txt');
      await cmd.shouldSucceed('rm /z/out/Exempelresa/dag-2/väder.txt');

      const answer = await expand('/z/out');

      assertEquals(answer.ok, false);
      assertEquals(answer.files, 1);
      assertEquals(answer.skipped, 2);
      assertEquals(answer.failed.map((failure) => failure.entry), ['lösa-blad.txt']);
      assertEquals(await text('/z/out/lösa-blad.txt'), 'a longer note someone else wrote here');
      assertEquals(await text('/z/out/Exempelresa/dag-2/väder.txt'), 'Sol hela dagen.');

      const result = await cmd.shouldFail('unzip -d /z/out /z/nested.zip');
      assertMatch(String(result.error), /lösa-blad\.txt: a file of another size is there/);
    });

    await t.step('-o writes over it', async () => {
      const answer = await client.execJson<UnzipAnswer>('unzip -o -d /z/out /z/nested.zip');

      assertEquals({ files: answer.files, skipped: answer.skipped, ok: answer.ok }, { files: 4, skipped: 0, ok: true });
      assertEquals(await text('/z/out/lösa-blad.txt'), 'Anna Andersson var med.');
    });

    await t.step('a file whose write never finished is written again', async () => {
      await cmd.shouldSucceed('mkdir -p /z/half/Exempelresa/dag-2');
      // As a write cut off leaves it: a node, and no sha256 recorded.
      await vfs.create(ADMIN_ACCESS, NODE_TYPE_FILE, '/z/half/Exempelresa/dag-2', 'väder.txt', { attrs: { name: 'väder.txt', size: 0 } });

      const answer = await expand('/z/half');

      assertEquals({ files: answer.files, skipped: answer.skipped, ok: answer.ok }, { files: 4, skipped: 0, ok: true });
      assertEquals(await text('/z/half/Exempelresa/dag-2/väder.txt'), 'Sol hela dagen.');
    });

    await t.step('an entry that would land outside the directory refuses the archive', async () => {
      const result = await cmd.shouldFail('unzip -d /z/slip /z/slip.zip');

      assertMatch(String(result.error), /refusing entry '\.\.\/utanfor\.txt'/);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/z/slip'), false);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/z/utanfor.txt'), false);
    });

    await t.step('the space check refuses what would not fit, before anything is written', async () => {
      const needs = Math.ceil(NESTED_BYTES * SPACE_FACTOR);

      const refused = await assertRejects(() => expand('/z/full', { free: needs - 1 }), UnzipRefusedError);
      assertMatch(refused.message, /^not enough space/);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/z/full'), false);

      assertEquals((await expand('/z/full', { free: needs })).files, 4);
    });

    await t.step('a run again needs room only for what it writes', async () => {
      await cmd.shouldSucceed('rm /z/full/lösa-blad.txt');

      await assertRejects(() => expand('/z/full', { free: Math.ceil(24 * SPACE_FACTOR) - 1 }), UnzipRefusedError);
      const answer = await expand('/z/full', { free: Math.ceil(24 * SPACE_FACTOR) });

      assertEquals({ files: answer.files, skipped: answer.skipped }, { files: 1, skipped: 3 });
    });

    await t.step('in text mode it says what it wrote', async () => {
      const output = await client.execString('export JSON_OUTPUT=0\nunzip -d /z/text /z/nested.zip');

      assertMatch(output, /^4 files \(454 B\) and 6 directories into \/z\/text/);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
