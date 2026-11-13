/**
 * `search --has <attr>=<value>`: only what holds the value in the attr, the attr being the value or
 * a list holding it, a nested one named with a dot. In the plain timeline, a subtree and its facets
 * it is a condition of the store query; under another driver (a container) a test of each node.
 * Repeated, every value must be held, and it goes with `--missing`; what is not `<attr>=<value>` is
 * refused; the answer echoes what was asked.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import type { SearchFacetsResponse, SearchResponse } from '../../api/search.ts';
import { ADMIN_ACCESS } from '../../access/mod.ts';
import { captureTime, createTestContext, testCommands } from '../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });

const names = (r: SearchResponse) => r.results.map((hit) => hit.path.split('/').pop()).sort();

Deno.test({
  name: 'search --has',
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
    // Scans read for damage, one faded and dusty, one scratched, one clean, one never read.
    await cmd.shouldSucceed('mkdir -p /scans/box');
    await mkmedia('/scans/a.jpg', { ...captureTime('1971-05-01T10:00:00'), damage: ['faded', 'dust'], reading: { kind: 'print' } });
    await mkmedia('/scans/box/b.jpg', { ...captureTime('1972-05-01T10:00:00'), damage: ['scratches'], reading: { kind: 'slide' } });
    await mkmedia('/scans/box/c.jpg', { ...captureTime('1973-05-01T10:00:00'), damage: [], reading: { kind: 'print' } });
    await mkmedia('/scans/box/d.jpg', { ...captureTime('1974-05-01T10:00:00') });
    // A scan nobody has dated yet.
    await mkmedia('/scans/box/e.jpg', { damage: ['faded'] });

    await t.step('the plain timeline: a list holding the value, the undated after the dated', async () => {
      const res = await client.execJson<SearchResponse>('search --kind photo --has damage=faded');
      assertEquals(res.results.map((hit) => hit.path.split('/').pop()), ['a.jpg', 'e.jpg']);
      assertEquals(res.filters.has, ['damage=faded']);
      assertEquals(names(await client.execJson<SearchResponse>('search --kind photo --has damage=scratches')), ['b.jpg']);
    });

    await t.step('a nested attr that is the value', async () => {
      assertEquals(names(await client.execJson<SearchResponse>('search --within /scans --has reading.kind=print')), ['a.jpg', 'c.jpg']);
    });

    await t.step('repeated, every value is held; with --missing both hold', async () => {
      assertEquals(names(await client.execJson<SearchResponse>('search --within /scans --has damage=faded --has damage=dust')), ['a.jpg']);
      assertEquals(names(await client.execJson<SearchResponse>('search --kind photo --has damage=faded --from 1970 --to 1975')), ['a.jpg']);
      assertEquals(names(await client.execJson<SearchResponse>('search --within /scans --has damage=faded --has damage=scratches')), []);
      assertEquals(names(await client.execJson<SearchResponse>('search --within /scans --has reading.kind=print --missing damage')), []);
    });

    await t.step('facets count the same set', async () => {
      const facets = await client.execJson<SearchFacetsResponse>('search --within /scans --has reading.kind=print --facets');
      assertEquals(facets.total, 2);
    });

    await t.step('another driver tests it on each node', async () => {
      assertEquals(names(await client.execJson<SearchResponse>('search --under /scans/box --has damage=scratches')), ['b.jpg']);
    });

    await t.step('what is not <attr>=<value> is refused', async () => {
      for (const entry of ['damage', 'damage=', '=faded', 'dam-age=faded']) {
        const refused = await client.exec(`search --within /scans --has '${entry}'`);
        assertEquals(refused.success, false, entry);
        assertStringIncludes(refused.error ?? '', `--has '${entry}' is not <attr>=<value>`);
      }
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
