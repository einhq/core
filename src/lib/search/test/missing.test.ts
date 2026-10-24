/**
 * `search --missing <attr>`: only what lacks the attr, a nested one named with a dot. In a
 * subtree, in the plain timeline, its facets and its layout it is a condition of the store query;
 * under another driver (a container) a test of each node. Repeated, every attr must be missing;
 * a name that is not an attr's is refused; the answer echoes what was asked.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import type { SearchFacetsResponse, SearchResponse } from '../../api/search.ts';
import { ADMIN_ACCESS } from '../../access/mod.ts';
import { captureTime, createTestContext, testCommands } from '../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });

type Layout = { truncated: boolean; layout: { directories: string[]; items: [number, string, ...unknown[]][] } };

const names = (r: SearchResponse) => r.results.map((hit) => hit.path.split('/').pop()).sort();

Deno.test({
  name: 'search --missing',
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
    // An inbox where one picture is a copy left unindexed and another a copy that was indexed.
    await cmd.shouldSucceed('mkdir -p /pile/upload');
    await mkmedia('/pile/a.jpg', { ...captureTime('2001-05-01T10:00:00'), duplicate: { sha256: 'a', at: 'then' } });
    await mkmedia('/pile/upload/b.jpg', { ...captureTime('2002-05-01T10:00:00'), duplicate: { sha256: 'a', at: 'then', kind: 'exact', of: 'x', deferred: true } });
    await mkmedia('/pile/upload/c.jpg', { ...captureTime('2003-05-01T10:00:00'), duplicate: { sha256: 'c', at: 'then', kind: 'exact', of: 'y' } });
    await mkmedia('/pile/upload/d.jpg', {});

    await t.step('in a subtree, by time with the undated after, only what lacks the nested attr', async () => {
      const res = await client.execJson<SearchResponse>('search --within /pile --missing duplicate.deferred');
      assertEquals(names(res), ['a.jpg', 'c.jpg', 'd.jpg']);
      assertEquals(res.filters.missing, ['duplicate.deferred']);
      assertEquals(names(await client.execJson<SearchResponse>('search --within /pile')), ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']);
    });

    await t.step('repeated, every attr is missing; a top-level attr needs no dot', async () => {
      assertEquals(names(await client.execJson<SearchResponse>('search --within /pile --missing duplicate.deferred --missing duplicate.kind')), ['a.jpg', 'd.jpg']);
      assertEquals(names(await client.execJson<SearchResponse>('search --within /pile --missing duplicate')), ['d.jpg']);
    });

    await t.step('the plain timeline carries it too', async () => {
      assertEquals(names(await client.execJson<SearchResponse>('search --kind photo --missing duplicate.deferred')), ['a.jpg', 'c.jpg']);
      assertEquals(names(await client.execJson<SearchResponse>('search --kind photo')), ['a.jpg', 'b.jpg', 'c.jpg']);
    });

    await t.step('facets and the layout count and lay out the same set', async () => {
      const facets = await client.execJson<SearchFacetsResponse>('search --within /pile --missing duplicate.deferred --facets');
      assertEquals(facets.total, 3);
      const layout = await client.execJson<Layout>('search --within /pile --sort time --missing duplicate.deferred --layout');
      assertEquals(layout.layout.items.map((row) => row[1]).sort(), ['a.jpg', 'c.jpg', 'd.jpg']);
    });

    await t.step('another driver tests it on each node', async () => {
      assertEquals(names(await client.execJson<SearchResponse>('search --under /pile/upload --missing duplicate.deferred')), ['c.jpg', 'd.jpg']);
    });

    await t.step('a name that is not an attr is refused', async () => {
      const refused = await client.exec("search --within /pile --missing 'duplicate-deferred'");
      assertEquals(refused.success, false);
      assertStringIncludes(refused.error ?? '', "--missing 'duplicate-deferred' is not an attr name");
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
