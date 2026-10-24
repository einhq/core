/**
 * position-set, position-get and find-containing.
 *
 * Shape semantics (centroid, containment, bbox) are covered by the position
 * registry conformance suite; this is the shell command path end-to-end against
 * the memory registry.
 */

import { assertEquals } from '@std/assert';
import type { PositionListing } from '../../../../lib/api/position.ts';
import type { PositionData } from '../../../../registries/position/types.ts';
import { createTestContext, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext();

const SQUARE = [
  { lat: 57.684, lng: 11.942 },
  { lat: 57.684, lng: 11.946 },
  { lat: 57.686, lng: 11.946 },
  { lat: 57.686, lng: 11.942 },
];

type FindResults = { results: { paths: string[] }[] };

Deno.test({
  name: 'position commands',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await t.step('position-set writes a point with radius', async () => {
      await cmd.shouldSucceed('mknode -t position /loc-home');
      await cmd.shouldSucceed('position-set /loc-home --lat=57.7 --lng=11.97 --radius 500');

      const data = await client.execJson<PositionData>('cat /loc-home');
      assertEquals(data, { lat: 57.7, lng: 11.97, radius: 500 });
    });

    await t.step('position-set makes a missing position under its parent', async () => {
      await cmd.shouldSucceed('mkdir /loc-location');
      await cmd.shouldSucceed('position-set /loc-location/position --lat=57.71 --lng=11.98');

      const data = await client.execJson<PositionData>('cat /loc-location/position');
      assertEquals(data, { lat: 57.71, lng: 11.98, radius: 0 });
      await cmd.shouldFailWith('position-set /loc-missing/position --lat=1 --lng=2', 'loc-missing');
    });

    await t.step('position-set writes a polygon and recenters on the centroid', async () => {
      await cmd.shouldSucceed('mknode -t position /loc-park');
      await cmd.shouldSucceed(`position-set /loc-park --polygon '${JSON.stringify(SQUARE)}'`);

      const data = await client.execJson<PositionData>('cat /loc-park');
      assertEquals(data.polygon, SQUARE);
      assertEquals(data.lat > 57.684 && data.lat < 57.686, true);
      assertEquals(data.lng > 11.942 && data.lng < 11.946, true);
    });

    await t.step('position-get answers where each node is: its own shape, its position child, or none', async () => {
      await cmd.shouldSucceed('mkdir /loc-nowhere');
      const answer = await client.execJson<PositionListing>('position-get /loc-location /loc-park /loc-nowhere /loc-gone');
      assertEquals(answer.nodes.map((node) => node.path), ['/loc-location', '/loc-park', '/loc-nowhere', '/loc-gone']);
      assertEquals(answer.nodes[0], { path: '/loc-location', name: 'loc-location', type: 'directory', position: { lat: 57.71, lng: 11.98 } });
      assertEquals(answer.nodes[1].position?.polygon, SQUARE);
      assertEquals(answer.nodes[2], { path: '/loc-nowhere', name: 'loc-nowhere', type: 'directory' });
      // A path that cannot be read is its entry's error, not the call's.
      assertEquals(typeof answer.nodes[3].error, 'string');
      await cmd.shouldFailWith('position-get', 'missing path');
    });

    await t.step('find-containing resolves matches to paths', async () => {
      const inside = await client.execJson<FindResults>('find-containing 57.685 11.944');
      assertEquals(inside.results.some((r) => r.paths.includes('/loc-park')), true);
      // /loc-home is 500m-radius circle far from the polygon
      assertEquals(inside.results.some((r) => r.paths.includes('/loc-home')), false);

      const outside = await client.execJson<FindResults>('find-containing 57.9 11.5');
      assertEquals(outside.results.length, 0);
    });

    await t.step('position-set --clear removes the shape', async () => {
      await cmd.shouldSucceed('position-set /loc-home --clear');
      const inside = await client.execJson<FindResults>('find-containing 57.7 11.97');
      assertEquals(inside.results.some((r) => r.paths.includes('/loc-home')), false);
    });

    await t.step('rejects invalid input', async () => {
      await cmd.shouldSucceed('mkfile /loc-notloc');
      await cmd.shouldFailWith('position-set /loc-notloc --lat=1 --lng=2', 'not position');
      await cmd.shouldFailWith('position-set /loc-home --lat=1', 'requires --lat and --lng');
      await cmd.shouldFailWith(`position-set /loc-home --polygon '[{"lat":1,"lng":2}]'`, 'at least 3');
      await cmd.shouldFailWith('find-containing 57.7', 'requires numeric lat and lng');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
