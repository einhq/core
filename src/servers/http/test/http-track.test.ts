/**
 * HTTP track ingest (POST /track/<path>) — the path a tracker device uses.
 * A device uploads a buffer of fixes; re-uploading one it already sent must
 * not duplicate anything, and the registry's summary follows along.
 */

import { assertEquals } from '@std/assert';
import { SystemTestHarness } from '../../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: false });

Deno.test({
  name: 'HTTP track ingest',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { baseUrl } = await harness.startPrimary();
  const client = await harness.createShellClient();
  const { cookie } = await harness.createHttpSession();

  const post = (path: string, body: string) =>
    fetch(`${baseUrl}/track/${path}`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body,
    });

  try {
    await t.step('POST /track appends points and updates the summary', async () => {
      await client.execJson('mknode -t track /http-track');

      const res = await post(
        'http-track',
        JSON.stringify([
          { lat: 57.7, lng: 11.97, ts: '2020-05-01T10:00:00Z' },
          { lat: 57.71, lng: 11.98, ts: '2020-05-01T10:01:00Z' },
        ]),
      );

      assertEquals(res.status, 200);
      assertEquals(await res.json(), { appended: 2, skipped: 0 });

      const summary = await client.execJson<{ points: number; firstTs: string; bbox: Record<string, number> }>('file-stat /http-track');
      assertEquals(summary.points, 2);
      assertEquals(summary.firstTs, '2020-05-01T10:00:00.000Z');
      assertEquals(summary.bbox, { north: 57.71, south: 57.7, east: 11.98, west: 11.97 });
    });

    await t.step('a re-uploaded buffer is skipped, not duplicated', async () => {
      const res = await post(
        'http-track',
        JSON.stringify([
          { lat: 57.71, lng: 11.98, ts: '2020-05-01T10:01:00Z' },
          { lat: 57.72, lng: 11.99, ts: '2020-05-01T10:02:00Z' },
        ]),
      );

      assertEquals(await res.json(), { appended: 1, skipped: 1 });
      assertEquals((await client.execJson<{ points: number }>('file-stat /http-track')).points, 3);
    });

    await t.step('newline-delimited JSON is accepted', async () => {
      const res = await post(
        'http-track',
        '{"lat":57.73,"lng":12.0,"ts":"2020-05-01T10:03:00Z"}\n{"lat":57.74,"lng":12.01,"ts":"2020-05-01T10:04:00Z"}',
      );

      assertEquals(await res.json(), { appended: 2, skipped: 0 });
    });

    await t.step('a point with no timestamp lands at arrival time', async () => {
      const before = Date.now();
      const res = await post('http-track', JSON.stringify({ lat: 57.75, lng: 12.02 }));

      assertEquals(await res.json(), { appended: 1, skipped: 0 });

      const summary = await client.execJson<{ lastTs: string }>('file-stat /http-track');
      assertEquals(Date.parse(summary.lastTs) >= before, true);
    });

    await t.step('POST /track rejects bad input', async () => {
      const bad = await post('http-track', 'not json at all {');
      assertEquals(bad.status, 400);
      await bad.body?.cancel();

      const noCoords = await post('http-track', JSON.stringify({ ts: '2020-05-01T11:00:00Z' }));
      assertEquals(noCoords.status, 400);
      await noCoords.body?.cancel();

      await client.execJson('mkfile /not-a-track');
      const notTrack = await post('../track/not-a-track', JSON.stringify({ lat: 1, lng: 2 }));
      assertEquals(notTrack.status, 400);
      await notTrack.body?.cancel();
    });
  } finally {
    client.close();
    await harness.stop();
  }
});
