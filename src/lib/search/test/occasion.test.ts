/**
 * `search --occasion <holiday>`: what was taken on a holiday's days, in every year of the window or
 * in every year at all, under the timeline and under another driver alike. The days are worked out
 * per year — midsummer is a Friday to Sunday that moves, Easter moves further — and a name no
 * occasion has is refused with the ones there are.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import type { SearchResponse } from '../../api/search.ts';
import { ADMIN_ACCESS } from '../../access/mod.ts';
import { captureTime, createTestContext, testCommands } from '../../../testing/mod.ts';
import { easterSunday, occasionCondition } from '../occasions.ts';

Deno.test('easterSunday', () => {
  for (const [year, date] of [[1961, '1961-04-02'], [2008, '2008-03-23'], [2011, '2011-04-24'], [2017, '2017-04-16'], [2019, '2019-04-21'], [2038, '2038-04-25']] as const) {
    assertEquals(easterSunday(year).toISOString().slice(0, 10), date);
  }
});

Deno.test('occasionCondition gives each year its days, by either language', () => {
  assertEquals(occasionCondition('Midsommar', 2018, 2020), {
    ref: 'takenAt',
    op: 'ranges',
    value: [['2018-06-22', '2018-06-25'], ['2019-06-21', '2019-06-24'], ['2020-06-19', '2020-06-22']],
  });
  assertEquals(occasionCondition('easter', 2017, 2017), { ref: 'takenAt', op: 'ranges', value: [['2017-04-14', '2017-04-18']] });
  assertEquals(occasionCondition('nyår', 1999, 1999), { ref: 'takenAt', op: 'ranges', value: [['1999-12-31', '2000-01-02']] });
  assertEquals(occasionCondition('birthday', 2000, 2000), undefined);
});

const testCtx = createTestContext({ boot: true });

const names = (r: SearchResponse) => r.results.map((hit) => hit.path.split('/').pop()).sort();

Deno.test({
  name: 'search --occasion',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const mkmedia = async (path: string, takenAt?: string) => {
    await cmd.shouldSucceed(`echo x > ${path}`);
    await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype: 'image/jpeg', ...(takenAt ? captureTime(takenAt) : {}) } });
  };

  try {
    await cmd.shouldSucceed('mkdir -p /album');
    await mkmedia('/album/eve-2018.jpg', '2018-06-22T18:00:00');
    await mkmedia('/album/sunday-2019.jpg', '2019-06-23T11:00:00');
    // A week of May, and the Friday after 2019's midsummer: neither is midsummer.
    await mkmedia('/album/may-2019.jpg', '2019-05-03T12:00:00');
    await mkmedia('/album/friday-after-2019.jpg', '2019-06-28T18:00:00');
    await mkmedia('/album/june-1980.jpg', '1980-06');
    await mkmedia('/album/easter-2017.jpg', '2017-04-16T10:00:00');
    await mkmedia('/album/undated.jpg');

    await t.step('every year, on the timeline', async () => {
      const res = await client.execJson<SearchResponse>('search --occasion midsommar');
      assertEquals(names(res), ['eve-2018.jpg', 'sunday-2019.jpg']);
      assertEquals(res.filters.occasion, 'midsommar');
    });

    await t.step('the window picks the years', async () => {
      assertEquals(names(await client.execJson<SearchResponse>('search --occasion midsummer --from 2019 --to 2019')), ['sunday-2019.jpg']);
      assertEquals(names(await client.execJson<SearchResponse>('search --occasion påsk --from 2010')), ['easter-2017.jpg']);
    });

    await t.step('another driver tests it on each node', async () => {
      assertEquals(names(await client.execJson<SearchResponse>('search --under /album --occasion midsummer')), ['eve-2018.jpg', 'sunday-2019.jpg']);
    });

    await t.step('a name no occasion has is refused with those there are', async () => {
      const refused = await client.exec('search --occasion birthday');
      assertEquals(refused.success, false);
      assertStringIncludes(refused.error ?? '', "'birthday' is not an occasion (midsummer, midsommar");
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
