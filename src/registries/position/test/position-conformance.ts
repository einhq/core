/**
 * Shared conformance suite for position registries. Reused by the memory
 * (fast tier) and PostgreSQL/PostGIS (PG tier) implementations.
 *
 * Positions are stored as JSON text ({"lat":..,"lng":..,"radius":..,
 * "polygon":[{lat,lng},..]}) encoded to bytes.
 */

import { assertEquals, assertRejects } from '@std/assert';
import type { PositionData, PositionRegistryIf } from '../types.ts';

export type PositionSetup = {
  registry: PositionRegistryIf;
  teardown(): Promise<void>;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

async function writePosition(registry: PositionRegistryIf, id: string, data: unknown): Promise<void> {
  const handle = await registry.open(id, {}, 'w');
  try {
    await handle.write(enc.encode(JSON.stringify(data)));
  } finally {
    await handle.close();
  }
}

async function readPosition(registry: PositionRegistryIf, id: string): Promise<PositionData | null> {
  const handle = await registry.open(id, {}, 'r');
  try {
    const data = await handle.read(0);
    if (data.length === 0) return null;
    return JSON.parse(dec.decode(data)) as PositionData;
  } finally {
    await handle.close();
  }
}

// A ~200x200m square (open ring)
const SQUARE = [
  { lat: 57.684, lng: 11.942 },
  { lat: 57.684, lng: 11.946 },
  { lat: 57.686, lng: 11.946 },
  { lat: 57.686, lng: 11.942 },
];
const INSIDE = { lat: 57.685, lng: 11.944 };
const OUTSIDE = { lat: 57.69, lng: 11.96 };

export type ConformanceOpts = {
  ignore?: boolean;
  sanitize?: boolean;
};

export function positionConformanceTests(name: string, setup: () => Promise<PositionSetup>, opts?: ConformanceOpts) {
  Deno.test({
    name,
    ignore: opts?.ignore ?? false,
    sanitizeResources: opts?.sanitize ?? true,
    sanitizeOps: opts?.sanitize ?? true,
  }, async (t) => {
    const { registry, teardown } = await setup();

    try {
      await t.step('point roundtrip preserves lat/lng/radius', async () => {
        await writePosition(registry, 'point', { lat: 57.7, lng: 11.97, radius: 500 });

        const data = await readPosition(registry, 'point');
        assertEquals(data, { lat: 57.7, lng: 11.97, radius: 500 });
      });

      await t.step('radius defaults to 0', async () => {
        await writePosition(registry, 'noradius', { lat: 10, lng: 20 });

        const data = await readPosition(registry, 'noradius');
        assertEquals(data, { lat: 10, lng: 20, radius: 0 });
      });

      await t.step('polygon roundtrip preserves the ring and centers the point inside', async () => {
        await writePosition(registry, 'poly', { polygon: SQUARE });

        const data = await readPosition(registry, 'poly');
        assertEquals(data?.polygon, SQUARE);

        // Center point is recomputed as the centroid, inside the ring's bbox
        assertEquals(data!.lat > 57.684 && data!.lat < 57.686, true);
        assertEquals(data!.lng > 11.942 && data!.lng < 11.946, true);
      });

      await t.step('a closed polygon ring is stored open', async () => {
        await writePosition(registry, 'closed', { polygon: [...SQUARE, SQUARE[0]] });

        const data = await readPosition(registry, 'closed');
        assertEquals(data?.polygon, SQUARE);
      });

      await t.step('writing a point clears a previous polygon', async () => {
        await writePosition(registry, 'poly-then-point', { polygon: SQUARE });
        await writePosition(registry, 'poly-then-point', { lat: 1, lng: 2 });

        const data = await readPosition(registry, 'poly-then-point');
        assertEquals(data?.polygon, undefined);
        assertEquals(data?.lat, 1);
      });

      await t.step('invalid data is rejected', async () => {
        const handle = await registry.open('bad', {}, 'w');
        try {
          await assertRejects(() => handle.write(enc.encode(JSON.stringify({ lat: 'x', lng: 2 }))));
          await assertRejects(() => handle.write(enc.encode(JSON.stringify({ polygon: [{ lat: 1, lng: 2 }] }))));
          await assertRejects(() => handle.write(enc.encode(JSON.stringify({ polygon: [{ lat: 1, lng: 'x' }, { lat: 2, lng: 3 }, { lat: 4, lng: 5 }] }))));
        } finally {
          await handle.close();
        }
      });

      await t.step('empty write clears the position', async () => {
        await writePosition(registry, 'cleared', { polygon: SQUARE });

        const handle = await registry.open('cleared', {}, 'w');
        try {
          await handle.write(new Uint8Array(0));
        } finally {
          await handle.close();
        }

        assertEquals(await readPosition(registry, 'cleared'), null);
      });

      await t.step('findNearby orders matches by distance and respects radius', async () => {
        await writePosition(registry, 'nb-close', { lat: 57.7, lng: 11.97 });
        await writePosition(registry, 'nb-closer', { lat: 57.7001, lng: 11.9701 });
        await writePosition(registry, 'nb-far', { lat: 58.6, lng: 16.2 });

        const matches = await registry.findNearby(57.7002, 11.9702, 5000, 10);
        const ids = matches.map((m) => m.id);

        assertEquals(ids.includes('nb-closer'), true);
        assertEquals(ids.includes('nb-close'), true);
        assertEquals(ids.includes('nb-far'), false);
        assertEquals(ids.indexOf('nb-closer') < ids.indexOf('nb-close'), true);

        for (let i = 1; i < matches.length; i++) {
          assertEquals(matches[i - 1].distance <= matches[i].distance, true);
        }
      });

      await t.step('findWithin returns points inside the bounding box', async () => {
        await writePosition(registry, 'in-box', { lat: 57.685, lng: 11.944 });
        await writePosition(registry, 'out-box', { lat: 59.33, lng: 18.07 });

        const matches = await registry.findWithin({ north: 57.7, south: 57.6, east: 12.0, west: 11.9 }, 100);
        const ids = matches.map((m) => m.id);

        assertEquals(ids.includes('in-box'), true);
        assertEquals(ids.includes('out-box'), false);

        const inBox = matches.find((m) => m.id === 'in-box')!;
        assertEquals(Math.abs(inBox.lat - 57.685) < 1e-6, true);
        assertEquals(Math.abs(inBox.lng - 11.944) < 1e-6, true);
      });

      await t.step('findWithin respects the limit', async () => {
        const matches = await registry.findWithin({ north: 90, south: -90, east: 180, west: -180 }, 1);
        assertEquals(matches.length, 1);
      });

      await t.step('findContaining matches polygons covering the point', async () => {
        await writePosition(registry, 'ct-poly', { polygon: SQUARE });

        const inside = await registry.findContaining(INSIDE.lat, INSIDE.lng, 10);
        assertEquals(inside.some((m) => m.id === 'ct-poly'), true);

        const outside = await registry.findContaining(OUTSIDE.lat, OUTSIDE.lng, 10);
        assertEquals(outside.some((m) => m.id === 'ct-poly'), false);
      });

      await t.step('findContaining falls back to radius without a polygon', async () => {
        await writePosition(registry, 'ct-circle', { lat: 57.65, lng: 12.05, radius: 1000 });
        await writePosition(registry, 'ct-point', { lat: 57.65, lng: 12.05 });

        const inside = await registry.findContaining(57.652, 12.05, 10);
        assertEquals(inside.some((m) => m.id === 'ct-circle'), true);
        // A bare point (radius 0) never contains anything
        assertEquals(inside.some((m) => m.id === 'ct-point'), false);

        const outside = await registry.findContaining(57.67, 12.05, 10);
        assertEquals(outside.some((m) => m.id === 'ct-circle'), false);
      });

      await t.step('a polygon overrides the radius fallback', async () => {
        // Point inside the big radius but outside the polygon must not match
        await writePosition(registry, 'ct-poly-radius', { polygon: SQUARE, radius: 100000 });

        const matches = await registry.findContaining(OUTSIDE.lat, OUTSIDE.lng, 10);
        assertEquals(matches.some((m) => m.id === 'ct-poly-radius'), false);
      });

      await t.step('getPoints answers the point of each id that has one', async () => {
        await writePosition(registry, 'gp-point', { lat: 57.7, lng: 11.97, radius: 500 });
        await writePosition(registry, 'gp-poly', { polygon: SQUARE });
        await registry.touch('gp-empty', {});

        const points = await registry.getPoints(['gp-point', 'gp-poly', 'gp-empty', 'gp-unknown', 'gp-point']);
        assertEquals([...points.keys()].sort(), ['gp-point', 'gp-poly']);
        assertEquals(points.get('gp-point'), { lat: 57.7, lng: 11.97 });
        // A polygon's point is its centroid, inside the ring.
        const centroid = points.get('gp-poly')!;
        assertEquals(centroid.lat > 57.684 && centroid.lat < 57.686, true);
        assertEquals(centroid.lng > 11.942 && centroid.lng < 11.946, true);

        assertEquals((await registry.getPoints([])).size, 0);
      });

      await t.step('an owner filter keeps the positions with an owner of those types, before the limit', async () => {
        // Somewhere no other step writes: a photo nearer than the place, and a place with two owners.
        await writePosition(registry, 'ow-photo', { lat: -33.9, lng: 18.4, radius: 50 });
        await writePosition(registry, 'ow-place', { lat: -33.901, lng: 18.4, radius: 500 });
        await writePosition(registry, 'ow-both', { lat: -33.902, lng: 18.4, radius: 500 });
        await writePosition(registry, 'ow-none', { lat: -33.9, lng: 18.4, radius: 500 });
        await registry.setOwners(new Map([['ow-photo', ['file']], ['ow-place', ['location']], ['ow-both', ['location', 'event']], ['ow-none', []]]));

        const location = { ownerTypes: ['location'] };
        assertEquals((await registry.findNearby(-33.9, 18.4, 1000, 1, location)).map((m) => m.id), ['ow-place']);
        assertEquals((await registry.findNearby(-33.9, 18.4, 1000, 10, location)).map((m) => m.id), ['ow-place', 'ow-both']);
        assertEquals((await registry.findNearby(-33.9, 18.4, 1000, 10, { ownerTypes: ['event', 'file'] })).map((m) => m.id), ['ow-photo', 'ow-both']);
        assertEquals((await registry.findNearby(-33.9, 18.4, 1000, 10, { ownerTypes: [] })).length, 0);
        assertEquals((await registry.findNearby(-33.9, 18.4, 1000, 10)).length, 4);

        const box = { north: -33.8, south: -34, east: 18.5, west: 18.3 };
        assertEquals((await registry.findWithin(box, 100, location)).map((m) => m.id).sort(), ['ow-both', 'ow-place']);
        assertEquals((await registry.findWithin(box, 100, { ownerTypes: ['file'] })).map((m) => m.id), ['ow-photo']);

        assertEquals((await registry.findContaining(-33.9, 18.4, 1, location)).map((m) => m.id), ['ow-place']);
        assertEquals((await registry.findContaining(-33.9, 18.4, 10, { ownerTypes: ['file'] })).map((m) => m.id), ['ow-photo']);
      });

      await t.step('setOwners replaces the owners, and unowned lists the positions never given any', async () => {
        await writePosition(registry, 'ow-moved', { lat: -33.95, lng: 18.45 });
        assertEquals((await registry.unowned(100_000)).includes('ow-moved'), true);
        assertEquals((await registry.unowned(1)).length, 1);

        await registry.setOwners(new Map([['ow-moved', ['file']], ['ow-unknown', ['file']]]));
        await registry.setOwners(new Map([['ow-moved', ['location', 'location']]]));
        assertEquals(await registry.exists('ow-unknown'), false);
        const unowned = await registry.unowned(100_000);
        assertEquals(unowned.includes('ow-moved'), false);
        // An empty list is recorded too: a position with no owner is not unowned.
        assertEquals(unowned.includes('ow-none'), false);

        const near = { lat: -33.95, lng: 18.45 };
        assertEquals((await registry.findNearby(near.lat, near.lng, 10, 10, { ownerTypes: ['file'] })).length, 0);
        assertEquals((await registry.findNearby(near.lat, near.lng, 10, 10, { ownerTypes: ['location'] })).map((m) => m.id), ['ow-moved']);
      });

      await t.step('delete removes the position from queries', async () => {
        await writePosition(registry, 'gone', { lat: 30, lng: 30, radius: 1000 });
        assertEquals(await registry.delete('gone'), true);
        assertEquals(await registry.exists('gone'), false);

        const matches = await registry.findContaining(30, 30, 10);
        assertEquals(matches.some((m) => m.id === 'gone'), false);
      });
    } finally {
      await teardown();
    }
  });
}
