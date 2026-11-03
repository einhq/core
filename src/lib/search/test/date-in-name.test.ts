/**
 * A date typed with words is a time filter, and a name that carries it too is what the words name:
 * "autumn trip 2014" finds the pictures of 2014 that match "autumn trip", and the undated album
 * called "Autumn trip 2014" first on the `name` channel, but neither the album of another year nor
 * a picture of one. A year given as both bounds, as the search box sends it, is the same; a window
 * open at one end is one only what has a date can be in.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../access/mod.ts';
import { captureTime, createTestContext, testCommands } from '../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });

type Results = { results: { path: string; channels?: Record<string, number> }[] };

const paths = (r: Results) => r.results.map((hit) => hit.path);

Deno.test({
  name: 'a name carrying the date typed is kept by the date filter',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await cmd.shouldSucceed('mkdir -p /albums/autumn-trip-2013 /albums/autumn-trip-2014 /library');
    for (const [name, takenAt] of [['trip-2014.jpg', '2014-10-01T10:00:00'], ['trip-2015.jpg', '2015-10-01T10:00:00']]) {
      await cmd.shouldSucceed(`echo x > /library/${name}`);
      await vfs.update(ADMIN_ACCESS, `/library/${name}`, { attrs: { mimetype: 'image/jpeg', ...captureTime(takenAt) } });
    }

    // A provider answering the words it is asked with both albums by name and both pictures by
    // what they show; it fails when the date reaches it, which `search` lifts out first.
    const answer = JSON.stringify({
      results: [
        { path: '/albums/autumn-trip-2013', type: 'dir', name: 'Autumn trip 2013', channel: 'name', score: 0.8 },
        { path: '/albums/autumn-trip-2014', type: 'dir', name: 'Autumn trip 2014', channel: 'name', score: 0.8 },
        { path: '/library/trip-2015.jpg', type: 'file', name: 'trip-2015.jpg', channel: 'picture', score: 0.2 },
        { path: '/library/trip-2014.jpg', type: 'file', name: 'trip-2014.jpg', channel: 'picture', score: 0.1 },
      ],
    });
    const bin = `/tmp/date-in-name-${crypto.randomUUID()}`;
    await cmd.shouldSucceed(`mkdir -p ${bin}`);
    await vfs.create(ADMIN_ACCESS, 'file', bin, 'search-trips', { props: { mode: 0o755 } });
    const script = await vfs.open(ADMIN_ACCESS, `${bin}/search-trips`, { mode: 'w' });
    try {
      await script.write(new TextEncoder().encode(
        `#!bash\nif [ "$1" = --kinds ]; then echo '{"kinds":["photo","dir"]}'; exit 0; fi\nif [ "$1" != 'autumn trip' ]; then exit 1; fi\necho '${answer}'\n`,
      ));
    } finally {
      await script.close();
    }
    const search = (args: string) => client.execJson<Results>(`PATH=${bin}:$PATH search ${args} --fields channels`);

    await t.step('the album named by the date leads its name channel, beside the pictures of that year', async () => {
      const found = await search("'autumn trip 2014'");
      assertEquals(paths(found), ['/albums/autumn-trip-2014', '/library/trip-2014.jpg']);
      assertEquals(found.results[0].channels, { name: 1 });
    });

    await t.step('the year may stand anywhere in the words', async () => {
      assertEquals(paths(await search("'2014 autumn trip'")), ['/albums/autumn-trip-2014', '/library/trip-2014.jpg']);
    });

    await t.step('a year given as both bounds names the album too', async () => {
      assertEquals(paths(await search("'autumn trip' --from 2014 --to 2014")), ['/albums/autumn-trip-2014', '/library/trip-2014.jpg']);
    });

    await t.step('a window open at one end holds only what has a date', async () => {
      assertEquals(paths(await search("'autumn trip' --from 2014")), ['/library/trip-2015.jpg', '/library/trip-2014.jpg']);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
