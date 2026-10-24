/**
 * `search --within` a directory: every picture, video and recording in the tree under it, however
 * deep, by time with the undated after; a seek into it; `--undated`, with and without a subtree;
 * its facets and its complete layout, and the layout it refuses above the container limit; paging
 * across the dated and the undated part; and what it does not combine with.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../access/mod.ts';
import { captureTime, createTestContext, testCommands } from '../../../testing/mod.ts';
import { CONTAINER_SCAN_LIMIT } from '../containers.ts';

const testCtx = createTestContext({ boot: true });

type Results = { results: { path: string; type: string; mimetype?: string; takenAtUtc?: string }[]; cursor: string | null; filters: { within: string | null } };
type Facets = { total: number; truncated: boolean; days: { key: string; count: number }[]; kinds: { kind: string; count: number }[] };
type Layout = { truncated: boolean; layout: { directories: string[]; items: [number, string, ...unknown[]][] } };

const names = (r: Results) => r.results.map((e) => e.path.split('/').pop());

Deno.test({
  name: 'search --within',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const mkmedia = async (path: string, attrs: Record<string, unknown>) => {
    await cmd.shouldSucceed(`echo x > ${path}`);
    await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype: 'image/jpeg', ...attrs } });
  };

  try {
    // An inbox of folders inside folders, a rendition under one file, and a link out of the tree.
    await cmd.shouldSucceed('mkdir -p /inbox/upload/Takeout/2019 /inbox/scans /outside');
    await mkmedia('/inbox/a.jpg', captureTime('2001-05-01T10:00:00'));
    await mkmedia('/inbox/upload/b.jpg', captureTime('2003-05-01T10:00:00'));
    await mkmedia('/inbox/upload/Takeout/2019/c.jpg', captureTime('2019-07-01T10:00:00'));
    await mkmedia('/inbox/scans/undated-1.jpg', {});
    await mkmedia('/inbox/scans/undated-2.jpg', {});
    // Files beside the media that are none: a dated document and an undated sidecar.
    await mkmedia('/inbox/upload/notes.pdf', { ...captureTime('2003-06-01T10:00:00'), mimetype: 'application/pdf' });
    await mkmedia('/inbox/scans/scan.json', { mimetype: 'application/json' });
    await mkmedia('/outside/elsewhere.jpg', captureTime('2010-01-01T10:00:00'));
    const a = await vfs.get(ADMIN_ACCESS, '/inbox/a.jpg');
    await cmd.shouldSucceed('mkdir -p /inbox/a.jpg/thumbnails');
    await mkmedia('/inbox/a.jpg/thumbnails/360.jpg', { ...captureTime('2001-05-01T10:00:00'), sourceId: a.id });
    await vfs.create(ADMIN_ACCESS, 'softlink', '/inbox', 'link.jpg', { props: { mode: 0o777, softlink: '/outside/elsewhere.jpg' } });

    await t.step('lists the media at any depth, not the files beside them, newest first, the undated last', async () => {
      const res = await client.execJson<Results>('search --within /inbox --sort -time');
      assertEquals(names(res).slice(0, 3), ['c.jpg', 'b.jpg', 'a.jpg']);
      assertEquals(names(res).slice(3).sort(), ['undated-1.jpg', 'undated-2.jpg']);
      assertEquals(res.filters.within, '/inbox');
      assertEquals(names(await client.execJson<Results>('search --within /inbox --sort time')).slice(0, 3), ['a.jpg', 'b.jpg', 'c.jpg']);
    });

    await t.step('a relative path resolves against the cwd', async () => {
      assertEquals(names(await client.execJson<Results>('cd /inbox && search --within upload --sort time')), ['b.jpg', 'c.jpg']);
    });

    await t.step('pages across the dated and the undated part without a gap or a repeat', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const page: Results = await client.execJson<Results>(`search --within /inbox --sort time -l 2${cursor ? ` --cursor '${cursor}'` : ''}`);
        seen.push(...names(page) as string[]);
        cursor = page.cursor;
        if (!cursor) break;
      }
      assertEquals(seen.slice(0, 3), ['a.jpg', 'b.jpg', 'c.jpg']);
      assertEquals(seen.slice(3).sort(), ['undated-1.jpg', 'undated-2.jpg']);
    });

    await t.step('a seek lands inside the subtree, with what is newer above it', async () => {
      const res = await client.execJson<Results & { anchorIndex: number }>('search --within /inbox --sort -time --at 2003');
      assertEquals(names(res).slice(0, 3), ['c.jpg', 'b.jpg', 'a.jpg']);
      assertEquals(res.anchorIndex, 1);
    });

    await t.step('--undated lists only what has no capture time', async () => {
      assertEquals(names(await client.execJson<Results>('search --within /inbox --undated')).sort(), ['undated-1.jpg', 'undated-2.jpg']);
    });

    await t.step('--undated with no subtree lists undated media, not directories or other files', async () => {
      const found: Results['results'] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 50; guard++) {
        const page: Results = await client.execJson<Results>(`search --undated -l 100${cursor ? ` --cursor '${cursor}'` : ''}`);
        found.push(...page.results);
        cursor = page.cursor;
        if (!cursor) break;
      }
      const paths = found.map((hit) => hit.path);
      assertEquals(paths.includes('/inbox/scans/undated-1.jpg') && paths.includes('/inbox/scans/undated-2.jpg'), true, JSON.stringify(paths));
      for (const hit of found) {
        assertEquals(hit.type, 'file', hit.path);
        assertEquals(/^(image|video|audio)\//.test(hit.mimetype ?? ''), true, hit.path);
        assertEquals(hit.takenAtUtc, undefined, hit.path);
      }
    });

    await t.step('a date window leaves the undated out', async () => {
      assertEquals(names(await client.execJson<Results>('search --within /inbox --from 2002 --sort time')), ['b.jpg', 'c.jpg']);
    });

    await t.step('facets count the media in the subtree, in the store', async () => {
      // Counted in the store, so a scan limit below the total does not cut it.
      const facets = await client.execJson<Facets>('search --within /inbox --facets --max-scan 2');
      assertEquals(facets.total, 5);
      assertEquals(facets.truncated, false);
      assertEquals(facets.days.map((day) => day.key), ['2001-05-01', '2003-05-01', '2019-07-01']);
      assertEquals(facets.kinds, [{ kind: 'photo', count: 5 }]);
    });

    await t.step('a small subtree is laid out whole, the undated included', async () => {
      const res = await client.execJson<Layout>('search --within /inbox --sort time --layout');
      assertEquals(res.truncated, false);
      const paths = res.layout.items.map((row) => `${res.layout.directories[row[0]]}/${row[1]}`);
      assertEquals(paths.slice(0, 3), ['/inbox/a.jpg', '/inbox/upload/b.jpg', '/inbox/upload/Takeout/2019/c.jpg']);
      assertEquals(paths.length, 5);
    });

    await t.step('a subtree above the container limit is not laid out, and pages instead', async () => {
      const empty = Array.from({ length: CONTAINER_SCAN_LIMIT + 1 }, (_, i) => ({ type: 'directory', name: `d${i}`, props: { mode: 0o755 } }));
      await vfs.createTree(ADMIN_ACCESS, '/', [{ type: 'directory', name: 'big', props: { mode: 0o755 }, children: empty }]);
      await mkmedia('/big/d0/a.jpg', captureTime('2001-05-01T10:00:00'));
      const res = await client.execJson<Layout>('search --within /big --sort time --layout');
      assertEquals(res.truncated, true);
      assertEquals(res.layout.items, []);
      assertEquals(names(await client.execJson<Results>('search --within /big --sort time')), ['a.jpg']);
    });

    await t.step('words, --under and a file are refused', async () => {
      assertEquals((await client.exec('search boat --within /inbox')).success, false);
      assertEquals((await client.exec('search --within /inbox --under /inbox')).success, false);
      assertEquals((await client.exec('search --within /inbox/a.jpg')).success, false);
      assertEquals((await client.exec('search --within /inbox --undated --from 2001')).success, false);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
