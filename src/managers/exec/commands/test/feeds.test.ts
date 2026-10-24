/**
 * `news`, `events` and `onthisday` gather what every `news-*`, `events-*` and `onthisday-*` command
 * on PATH answers, order the whole list and cut it to the limit, marking each entry with its
 * provider. A provider that fails, or answers something else, is named on stderr and the others
 * still answer; only when every one fails does the command.
 */
import { assertEquals, assertStringIncludes } from '@std/assert';
import type { EventEntry, NewsEntry, OnThisDayEntry } from '../../../../lib/api/feeds.ts';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { createTestContext } from '../../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });

/** Bash bodies for the stub providers; each echoes its arguments into a title where that is checked. */
const PROVIDERS: Record<string, string> = {
  'news-alpha':
    `echo "[{\\"at\\":300,\\"title\\":\\"alpha new, asked $*\\",\\"route\\":\\"/alpha/1\\",\\"by\\":{\\"uid\\":7,\\"username\\":\\"anna\\",\\"name\\":\\"Anna Andersson\\"}},{\\"at\\":100,\\"title\\":\\"alpha old\\",\\"route\\":\\"/alpha/2\\"}]"`,
  'news-beta':
    `echo '[{"at":200,"title":"beta","route":"/beta/1","icon":"photo","path":"/archive/albums/beta"},{"at":400,"title":"no route"},{"at":"soon","title":"no time","route":"/beta/2"},{"at":1e18,"title":"in nanoseconds","route":"/beta/3"}]'`,
  'news-broken': `echo boom >&2; exit 3`,
  'events-alpha':
    `echo "[{\\"date\\":\\"2026-09-03\\",\\"title\\":\\"tomorrow, asked $*\\",\\"route\\":\\"/a/1\\"},{\\"date\\":\\"2026-09-30\\",\\"title\\":\\"far milestone\\",\\"route\\":\\"/a/2\\",\\"milestone\\":true},{\\"date\\":\\"2026-12-24\\",\\"title\\":\\"outside\\",\\"route\\":\\"/a/3\\"}]"`,
  'events-beta':
    `echo '[{"date":"2026-09-01","title":"yesterday","route":"/b/1"},{"date":"2026-09-02","title":"today","route":"/b/2","path":"relative"},{"date":"2026-02-30","title":"no such day","route":"/b/3"}]'`,
  'onthisday-alpha':
    `echo "[{\\"year\\":2019,\\"title\\":\\"alpha 2019, asked $*\\",\\"route\\":\\"/a/2019\\"},{\\"year\\":2010,\\"title\\":\\"alpha 2010\\",\\"route\\":\\"/a/2010\\"}]"`,
  'onthisday-beta': `echo 'not json'`,
};

Deno.test({ name: 'news, events and onthisday', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  let fed: Awaited<ReturnType<typeof testCtx.server.createShellClient>> | undefined;

  try {
    await t.step('with no provider on PATH each answers an empty list', async () => {
      assertEquals(await client.execJson<NewsEntry[]>('news'), []);
      assertEquals(await client.execJson<EventEntry[]>('events --today 2026-09-02'), []);
      assertEquals(await client.execJson<OnThisDayEntry[]>('onthisday 09-02'), []);
    });

    await t.step('a malformed flag or day is refused', async () => {
      for (
        const [command, message] of [
          ['news --limit=x', '--limit must be a non-negative whole number'],
          ['events --today 2026-9-2', '--today must be YYYY-MM-DD'],
          ['events --days-ahead=', '--days-ahead must be a non-negative whole number'],
          ['onthisday 02-30', 'expected the day as MM-DD'],
        ]
      ) {
        const result = await client.exec(command);
        assertEquals(result.success, false, command);
        assertStringIncludes(result.error ?? '', message);
      }
    });

    // On a PATH of their own, so the lookup of the empty one above is not what is remembered.
    await client.exec('mkdir -p /opt/feeds');
    for (const [name, body] of Object.entries(PROVIDERS)) {
      await client.exec(`mkfile /opt/feeds/${name} && chmod 755 /opt/feeds/${name}`);
      const handle = await vfs.open(ADMIN_ACCESS, `/opt/feeds/${name}`, { mode: 'w' });
      try {
        await handle.write(new TextEncoder().encode(`${body}\n`));
      } finally {
        await handle.close();
      }
    }
    await client.exec(`echo 'export PATH="$PATH:/opt/feeds"' >> /etc/bashrc`);
    fed = await testCtx.server.createShellClient();
    const shell = fed;

    await t.step('news: every provider at once, newest first, cut as one list, each marked with its provider', async () => {
      const entries = await shell.execJson<NewsEntry[]>('news --limit 3');
      assertEquals(entries.map((entry) => [entry.at, entry.source, entry.route]), [[300, 'alpha', '/alpha/1'], [200, 'beta', '/beta/1'], [100, 'alpha', '/alpha/2']]);
      // Each provider is asked for the whole limit.
      assertEquals(entries[0].title, 'alpha new, asked --limit 3');
      assertEquals(entries[0].by, { uid: 7, username: 'anna', name: 'Anna Andersson' });
      assertEquals(entries[1].icon, 'photo');
      // The node an entry is about is passed on.
      assertEquals([entries[0].path, entries[1].path], [undefined, '/archive/albums/beta']);
      assertEquals((await shell.execJson<NewsEntry[]>('news --limit 1')).map((entry) => entry.route), ['/alpha/1']);
      assertEquals(await shell.execJson<NewsEntry[]>('news --limit 0'), []);
    });

    await t.step('a failing provider and a malformed entry are named, and the rest still answers', async () => {
      const text = await shell.execString('news 2>&1', { json: false });
      assertStringIncludes(text, 'news: news-broken: boom');
      // No route, a time that is no number, and one that is no instant.
      assertStringIncludes(text, 'news: news-beta: left out 3 entries not in the news shape');
      assertStringIncludes(text, 'alpha new');
    });

    await t.step('events: in the window only, milestones then the nearest survive, in date order', async () => {
      const entries = await shell.execJson<EventEntry[]>('events --today 2026-09-02 --limit 3');
      // Yesterday and tomorrow are as near; the one still to come survives.
      assertEquals(entries.map((entry) => entry.title.split(',')[0]), ['today', 'tomorrow', 'far milestone']);
      assertEquals(entries[2].milestone, true);
      // A path that is no node path is not passed on.
      assertEquals(entries[0].path, undefined);
      assertStringIncludes(await shell.execString('events --today 2026-09-02', { json: false }), '* far milestone');
      const all = await shell.execJson<EventEntry[]>('events --today 2026-09-02');
      assertEquals(all.map((entry) => entry.date), ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-30']);
      assertEquals(all[2].title, 'tomorrow, asked --today 2026-09-02 --days-ahead 30 --days-past 7 --limit 16');
      // A window that ends tomorrow leaves the milestone out, however notable.
      const narrow = await shell.execJson<EventEntry[]>('events --today 2026-09-02 --days-ahead 1 --days-past 0');
      assertEquals(narrow.map((entry) => entry.title.split(',')[0]), ['today', 'tomorrow']);
    });

    await t.step('onthisday: newest year first; a provider answering no list is named and skipped', async () => {
      const entries = await shell.execJson<OnThisDayEntry[]>('onthisday 09-02 --limit 5');
      assertEquals(entries.map((entry) => [entry.year, entry.source]), [[2019, 'alpha'], [2010, 'alpha']]);
      assertEquals(entries[0].title, 'alpha 2019, asked 09-02 --limit 5');
      const text = await shell.execString('onthisday 09-02 2>&1', { json: false });
      assertStringIncludes(text, 'onthisday: onthisday-beta: answered something other than a list of entries');
    });

    await t.step('when every provider fails, so does the command', async () => {
      await client.exec('rm /opt/feeds/news-alpha /opt/feeds/news-beta');
      const only = await testCtx.server.createShellClient();
      try {
        // The lookup may still list the removed two for a few seconds; either way nothing asked answers.
        const result = await only.exec('news');
        assertEquals(result.success, false);
      } finally {
        only.close();
      }
    });
  } finally {
    fed?.close();
    client.close();
    await testCtx.teardown();
  }
});
