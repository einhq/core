/**
 * Tracker links (GET|POST /tracker/<track id>.<token>): a phone or GPS tracker posts fixes without a
 * session, in any protocol it speaks, appended as the track's owner; `track-token` makes, shows,
 * replaces and turns off the link, for whoever may change the track and nobody else.
 */

import { assert, assertEquals, assertMatch, assertNotEquals } from '@std/assert';
import type { TrackToken } from '../../../lib/api/track.ts';
import { SystemTestHarness, testCommands } from '../../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: false });

const TRACK = '/home/anna/boat';

Deno.test({
  name: 'HTTP tracker links',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { baseUrl } = await harness.start();
  const admin = await harness.createShellClient();
  const cmd = testCommands(admin);

  await cmd.shouldSucceed('user-create anna');
  await cmd.shouldSucceed('user-passwd anna --new-password secret1');
  await cmd.shouldSucceed('user-create bertil');
  await cmd.shouldSucceed('user-passwd bertil --new-password secret2');
  const anna = await harness.createShellClient({ username: 'anna', password: 'secret1' });
  const bertil = await harness.createShellClient({ username: 'bertil', password: 'secret2' });

  let link = '';
  const send = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${baseUrl}${path}`, init);
    const text = await res.text();
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
  };
  const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const pointsOf = async () => (await anna.execString(`cat ${TRACK}`)).trim().split('\n').filter(Boolean).map((line: string) => JSON.parse(line));

  try {
    await t.step('a track has no link until one is made, and then shows the same one again', async () => {
      await anna.execJson(`mknode -t track ${TRACK}`);
      assertEquals(await anna.execJson<TrackToken>(`track-token ${TRACK}`), { track: TRACK, enabled: false });

      const made = await anna.execJson<TrackToken>(`track-token ${TRACK} --new`);
      assertEquals(made.enabled, true);
      assertMatch(made.path!, /^\/tracker\/[0-9A-Z]{26}\.[A-Za-z0-9]{22}$/);
      link = made.path!;
      assertEquals((await anna.execJson<TrackToken>(`track-token ${TRACK}`)).path, link);
    });

    await t.step('only someone who may change the track sees its link, and its owner cannot read the token node', async () => {
      await cmd.shouldSucceed(`chmod 0755 /home/anna ${TRACK}`);
      await testCommands(bertil).shouldFailWith(`track-token ${TRACK}`, 'only someone who may change the track');
      assertEquals((await anna.exec(`attrs ${TRACK}/.tracker`)).success, false);
    });

    await t.step("Traccar Client's JSON is appended, speed in m/s", async () => {
      const res = await send(
        link,
        json({
          device_id: 'phone',
          location: { timestamp: '2024-06-01T10:00:00Z', coords: { latitude: 57.5, longitude: 11.9, speed: 2.5, heading: -1, altitude: 4 } },
        }),
      );
      assertEquals(res, { status: 200, body: { appended: 1, skipped: 0 } });
      assertEquals(await pointsOf(), [{ lat: 57.5, lng: 11.9, ts: '2024-06-01T10:00:00.000Z', alt: 4, speed: 2.5 }]);
    });

    await t.step('OsmAnd as a query and as a form body, speed in knots', async () => {
      const query = await send(`${link}?id=phone&lat=57.51&lon=11.91&timestamp=1717236060&speed=10&bearing=90`);
      assertEquals(query, { status: 200, body: { appended: 1, skipped: 0 } });

      const form = await send(link, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'id=phone&lat=57.52&lon=11.92&timestamp=1717236120',
      });
      assertEquals(form, { status: 200, body: { appended: 1, skipped: 0 } });

      const byTime = await pointsOf();
      assertEquals(byTime.length, 3);
      assertEquals(byTime[1].ts, '2024-06-01T10:01:00.000Z');
      assert(Math.abs(byTime[1].speed - 10 * 1852 / 3600) < 1e-9);
      assertEquals(byTime[1].course, 90);
    });

    await t.step('a GPRMC sentence lands at its own time; a void fix and a ping are answered 200 with nothing appended', async () => {
      const sentence = encodeURIComponent('$GPRMC,100300,A,5731.800,N,01155.800,E,0.0,0.0,010624,,');
      assertEquals(await send(`${link}?id=boat&gprmc=${sentence}`), { status: 200, body: { appended: 1, skipped: 0 } });
      assertEquals((await pointsOf()).at(-1).ts, '2024-06-01T10:03:00.000Z');

      const empty = { status: 200, body: { appended: 0, skipped: 0 } };
      assertEquals(await send(`${link}?id=boat&gprmc=${encodeURIComponent('$GPRMC,100400,V,,,,,,,010624,,')}`), empty);
      assertEquals(
        await send(link, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'id=phone&notificationToken=abc' }),
        empty,
      );
      assertEquals((await pointsOf()).length, 4);
    });

    await t.step("EiN's own points, and a re-sent one skipped", async () => {
      const res = await send(link, json([{ lat: 57.53, lng: 11.93, ts: '2024-06-01T10:05:00Z' }, { lat: 57.5, lng: 11.9, ts: '2024-06-01T10:00:00Z' }]));
      assertEquals(res, { status: 200, body: { appended: 1, skipped: 1 } });
    });

    await t.step('an unreadable body is a 400', async () => {
      assertEquals((await send(link, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json {' })).status, 400);
      assertEquals((await send(`${link}?lat=95&lon=11`)).status, 400);
    });

    await t.step('a wrong token, an unknown track and no token at all are refused alike', async () => {
      const id = link.split('/')[2].split('.')[0];
      assertEquals((await send(`/tracker/${id}.${'A'.repeat(22)}?lat=1&lon=2`)).status, 403);
      assertEquals((await send(`/tracker/${'0'.repeat(26)}.${link.split('.')[1]}?lat=1&lon=2`)).status, 403);
      assertEquals((await send(`/tracker/${id}?lat=1&lon=2`)).status, 403);
      assertEquals((await pointsOf()).length, 5);
    });

    await t.step("points are appended as the track's owner: a track its owner may not change takes none", async () => {
      await cmd.shouldSucceed(`chmod 0555 ${TRACK}`);
      assertEquals((await send(`${link}?lat=1&lon=2`)).status, 403);
      await cmd.shouldSucceed(`chmod 0755 ${TRACK}`);
    });

    await t.step('a new link replaces the old one, and turning it off stops both', async () => {
      const renewed = await anna.execJson<TrackToken>(`track-token ${TRACK} --new`);
      assertNotEquals(renewed.path, link);
      assertEquals((await send(`${link}?lat=1&lon=2`)).status, 403);
      assertEquals((await send(`${renewed.path}?lat=1&lon=2`)).status, 200);

      assertEquals(await anna.execJson<TrackToken>(`track-token ${TRACK} --off`), { track: TRACK, enabled: false });
      assertEquals((await send(`${renewed.path}?lat=1&lon=3`)).status, 403);
    });

    await t.step('the owner can still delete a track that has a link', async () => {
      await anna.execJson(`track-token ${TRACK} --new`);
      await testCommands(anna).shouldSucceed(`rm -r ${TRACK}`);
      assertEquals((await anna.exec(`stat ${TRACK}`)).success, false);
    });
  } finally {
    anna.close();
    bertil.close();
    admin.close();
    await harness.stop();
  }
});
