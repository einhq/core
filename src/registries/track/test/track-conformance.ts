/**
 * Shared conformance suite for track registries. Reused by the memory (fast
 * tier) and PostGIS (PG tier) implementations, which is what keeps the two
 * answering a viewport read the same way.
 */

import { assertAlmostEquals, assertEquals, assertRejects } from '@std/assert';
import type { RouterManagerIf } from '../../../managers/router/mod.ts';
import type { TrackPoint, TrackReadResult, TrackRegistryIf } from '../types.ts';
import { waitFor } from '../../test/relay-wait.ts';

export type TrackSetup = {
  registry: TrackRegistryIf;
  router: RouterManagerIf;
  teardown(): Promise<void>;
};

export type ConformanceOpts = {
  ignore?: boolean;
  sanitize?: boolean;
};

const BASE = Date.parse('2015-07-04T10:00:00.000Z');

/** A run of points a second apart, drifting north-east. */
const run = (count: number, offset = 0, stepMs = 1000): TrackPoint[] =>
  Array.from({ length: count }, (_, i) => ({
    lat: 57.7 + (i + offset) * 0.0001,
    lng: 11.97 + (i + offset) * 0.0001,
    ts: new Date(BASE + (i + offset) * stepMs).toISOString(),
  }));

const allPoints = (segments: { points: TrackPoint[] }[]): TrackPoint[] => segments.flatMap((segment) => segment.points);

export function trackConformanceTests(name: string, setup: () => Promise<TrackSetup>, opts?: ConformanceOpts) {
  Deno.test({
    name,
    ignore: opts?.ignore ?? false,
    sanitizeResources: opts?.sanitize ?? true,
    sanitizeOps: opts?.sanitize ?? true,
    fn: async (t) => {
      const { registry, router, teardown } = await setup();

      try {
        await t.step('append and read back in time order', async () => {
          await registry.touch('t1', {});
          const written = await registry.appendPoints('t1', run(10));

          assertEquals(written, 10);

          const result = await registry.readPoints('t1');
          const points = allPoints(result.segments);

          assertEquals(points.length, 10);
          assertEquals(points[0].ts, new Date(BASE).toISOString());

          for (let i = 1; i < points.length; i++) {
            assertEquals(points[i - 1].ts < points[i].ts, true);
          }
        });

        await t.step('a duplicate timestamp is ignored', async () => {
          const written = await registry.appendPoints('t1', run(3));

          assertEquals(written, 0);
          assertEquals((await registry.summary('t1')).points, 10);
        });

        await t.step('an import past the bind-parameter limit lands whole', async () => {
          // A whole GPX file arrives in one call, often tens of thousands of
          // fixes. A per-point tuple list stops binding at ~10 900, so this is
          // the size that says whether the insert scales.
          await registry.touch('t11', {});
          const written = await registry.appendPoints('t11', run(12_000));

          assertEquals(written, 12_000);

          const summary = await registry.summary('t11');

          assertEquals(summary.points, 12_000);
          assertEquals(summary.firstTs, new Date(BASE).toISOString());
          assertEquals(summary.lastTs, new Date(BASE + 11_999_000).toISOString());

          // Spot-check deep into the run: no gap, no duplicate.
          const middle = allPoints(
            (await registry.readPoints('t11', {
              from: new Date(BASE + 10_920_000).toISOString(),
              to: new Date(BASE + 10_925_000).toISOString(),
            })).segments,
          );

          assertEquals(middle.length, 5);
          assertEquals(middle[0].ts, new Date(BASE + 10_920_000).toISOString());

          // Re-importing the same file is still a no-op at this size.
          assertEquals(await registry.appendPoints('t11', run(12_000)), 0);
          assertEquals((await registry.summary('t11')).points, 12_000);
        });

        await t.step('out-of-order points read back in time order', async () => {
          await registry.touch('t2', {});
          // Later half first, as a backdating import delivers it.
          await registry.appendPoints('t2', run(5, 10));
          await registry.appendPoints('t2', run(5, 0));

          const points = allPoints((await registry.readPoints('t2')).segments);

          assertEquals(points.length, 10);
          for (let i = 1; i < points.length; i++) {
            assertEquals(points[i - 1].ts < points[i].ts, true);
          }
        });

        await t.step('summary without reading the points', async () => {
          const summary = await registry.summary('t1');

          assertEquals(summary.points, 10);
          assertEquals(summary.firstTs, new Date(BASE).toISOString());
          assertEquals(summary.lastTs, new Date(BASE + 9000).toISOString());
          assertAlmostEquals(summary.bbox!.south, 57.7, 1e-9);
          assertAlmostEquals(summary.bbox!.north, 57.7009, 1e-9);
          assertAlmostEquals(summary.bbox!.west, 11.97, 1e-9);
          assertAlmostEquals(summary.bbox!.east, 11.9709, 1e-9);
        });

        await t.step('stat reports point count and routing keys', async () => {
          await registry.touch('t3', { routingKeys: ['tracker.fix'] });
          const stat = await registry.stat('t3');

          assertEquals(stat.size, 0);
          assertEquals(stat.points, 0);
          assertEquals(stat.routingKeys, ['tracker.fix']);
        });

        await t.step('summaries answers many tracks at once, without unknown ids', async () => {
          const summaries = await registry.summaries(['t1', 't3', 'no-such-track']);

          assertEquals([...summaries.keys()].sort(), ['t1', 't3']);
          assertEquals(summaries.get('t1'), await registry.summary('t1'));
          assertEquals(summaries.get('t3'), { points: 0 });
          assertEquals((await registry.summaries([])).size, 0);
        });

        await t.step('a bbox read returns only what is near the box', async () => {
          await registry.touch('t4', {});
          await registry.appendPoints('t4', run(200));

          const all = await registry.readPoints('t4');
          const box = await registry.readPoints('t4', {
            bounds: { south: 57.7, north: 57.7025, west: 11.97, east: 11.9725 },
            margin: 0,
          });

          assertEquals(allPoints(all.segments).length, 200);
          // ~26 points fall inside; the rest must not be shipped.
          assertEquals(allPoints(box.segments).length < 40, true);
          assertEquals(allPoints(box.segments).length > 0, true);
        });

        await t.step('a time window read returns only that window', async () => {
          const result = await registry.readPoints('t4', {
            from: new Date(BASE + 10_000).toISOString(),
            to: new Date(BASE + 20_000).toISOString(),
          });

          const points = allPoints(result.segments);

          assertEquals(points.length, 10);
          assertEquals(points[0].ts, new Date(BASE + 10_000).toISOString());
          assertEquals(points[points.length - 1].ts, new Date(BASE + 19_000).toISOString());
        });

        await t.step('simplify drops vertices but keeps the ends', async () => {
          const full = await registry.readPoints('t4');
          const thin = await registry.readPoints('t4', { tolerance: 0.001 });

          const fullPoints = allPoints(full.segments);
          const thinPoints = allPoints(thin.segments);

          assertEquals(thinPoints.length < fullPoints.length, true);
          assertEquals(thinPoints[0].ts, fullPoints[0].ts);
          assertEquals(thinPoints[thinPoints.length - 1].ts, fullPoints[fullPoints.length - 1].ts);
        });

        await t.step('a pause cuts the line', async () => {
          await registry.touch('t5', {});
          await registry.appendPoints('t5', run(5));
          // Two hours later, well past the gap floor.
          await registry.appendPoints(
            't5',
            run(5, 0, 1000).map((point) => ({
              ...point,
              ts: new Date(Date.parse(point.ts) + 7_200_000).toISOString(),
            })),
          );

          const result = await registry.readPoints('t5');

          assertEquals(result.segments.length, 2);
        });

        await t.step('a day boundary cuts the line', async () => {
          await registry.touch('t6', {});
          const midnight = Date.parse('2015-07-05T00:00:00.000Z');
          await registry.appendPoints(
            't6',
            Array.from({ length: 6 }, (_, i) => ({
              lat: 57.7 + i * 0.0001,
              lng: 11.97,
              ts: new Date(midnight - 3000 + i * 1000).toISOString(),
            })),
          );

          const result = await registry.readPoints('t6');

          assertEquals(result.segments.map((segment) => segment.day), ['2015-07-04', '2015-07-05']);
          // The second segment starts on the last point of the first, so the
          // drawn line has no hole at midnight.
          assertEquals(result.segments[1].points[0].ts, result.segments[0].points[result.segments[0].points.length - 1].ts);
        });

        await t.step('a track holding one point reads that point back', async () => {
          // A one-vertex segment draws nothing, but the read is the only path
          // to the fix, so it comes back like any other.
          await registry.touch('t-lone', {});
          await registry.appendPoints('t-lone', [{ lat: 57.7, lng: 11.97, ts: new Date(BASE).toISOString() }]);

          assertEquals((await registry.summary('t-lone')).points, 1);

          const result = await registry.readPoints('t-lone');

          assertEquals(result.points, 1);
          assertEquals(allPoints(result.segments).length, 1);
          assertEquals(allPoints(result.segments)[0].lat, 57.7);
          assertEquals(result.truncated, false);
        });

        await t.step('an isolated fix is not dropped out of the middle of a track', async () => {
          // A fix alone on its own day comes back too, and the read says it is
          // not truncated only because nothing was left out.
          await registry.touch('t-gap', {});
          const day1 = Date.parse('2015-07-01T10:00:00.000Z');
          const day3 = Date.parse('2015-07-03T10:00:00.000Z');
          await registry.appendPoints('t-gap', [
            { lat: 57.0, lng: 11.0, ts: new Date(day1).toISOString() },
            { lat: 58.0, lng: 12.0, ts: new Date(day3).toISOString() },
            { lat: 58.001, lng: 12.001, ts: new Date(day3 + 60_000).toISOString() },
          ]);

          const result = await registry.readPoints('t-gap');

          assertEquals(result.points, 3);
          assertEquals(result.truncated, false);
          // The lone fix keeps its own day rather than being joined across two days.
          assertEquals(result.segments.map((segment) => segment.day), ['2015-07-01', '2015-07-03']);
          assertEquals(allPoints(result.segments).map((point) => point.lat), [57.0, 58.0, 58.001]);
        });

        await t.step('a simplified read keeps a lone day too', async () => {
          // The postgres path builds one LINESTRINGM per day; a one-point day is
          // one of them.
          const result = await registry.readPoints('t-gap', { tolerance: 0.00001 });

          assertEquals(allPoints(result.segments).some((point) => Math.abs(point.lat - 57.0) < 0.001), true);
        });

        await t.step('a still read collapses a stay and drops a spike', async () => {
          // In from the south, 40 minutes drifting on the berth with one fix thrown 800 m off, and out
          // to the north: a fix every 20 s, no speed recorded. The spike is too short for the rules
          // the track is stored by, so it is the read's to drop.
          const metre = 1 / 111_320;
          const at = (i: number, north: number, east = 0): TrackPoint => ({
            lat: 57.7 + north * metre,
            lng: 11.97 + east * metre * 2,
            ts: new Date(BASE + i * 20_000).toISOString(),
          });
          const points = [
            ...Array.from({ length: 10 }, (_, i) => at(i, -500 + i * 50)),
            ...Array.from({ length: 120 }, (_, i) => i === 60 ? at(10 + i, 800) : at(10 + i, ((i % 5) - 2) * 6, ((i % 7) - 3) * 5)),
            ...Array.from({ length: 10 }, (_, i) => at(130 + i, (i + 1) * 50)),
          ];
          await registry.touch('t-still', {});
          await registry.appendPoints('t-still', points);

          const onBerth = (read: { segments: { points: TrackPoint[] }[] }) => allPoints(read.segments).filter((point) => Math.abs(point.lat - 57.7) < 20 * metre);

          const raw = await registry.readPoints('t-still');
          assertEquals(raw.points, points.length);

          const still = await registry.readPoints('t-still', { still: {} });
          const [arrival, departure] = onBerth(still);
          assertEquals(onBerth(still).length, 2);
          assertEquals([arrival.lat, arrival.lng], [departure.lat, departure.lng]);
          assertEquals(Date.parse(departure.ts) - Date.parse(arrival.ts) >= 38 * 60_000, true);
          assertEquals(allPoints(still.segments).some((point) => point.lat > 57.7 + 600 * metre), false);
          // The approach and the departure stay as they were.
          const kept = allPoints(still.segments).map((point) => point.ts);
          for (const i of [0, 4, 8, 131, 135, 139]) assertEquals(kept.includes(points[i].ts), true);

          // Simplified finely enough to keep the drift, it collapses the same way.
          const fine = await registry.readPoints('t-still', { tolerance: 0.000001, still: {} });
          assertEquals(onBerth(fine).length, 2);
          assertEquals(allPoints(fine.segments).some((point) => point.lat > 57.7 + 600 * metre), false);

          // Simplified past the drift, the spike is still gone.
          const coarse = await registry.readPoints('t-still', { tolerance: 0.001, still: {} });
          assertEquals(allPoints(coarse.segments).some((point) => point.lat > 57.7 + 600 * metre), false);
          const unfiltered = await registry.readPoints('t-still', { tolerance: 0.001 });
          assertEquals(allPoints(unfiltered.segments).some((point) => point.lat > 57.7 + 600 * metre), true);
        });

        // Steady going a fix a second, two degrees north for `away` fixes, and back on course.
        const excursion = (offset: number, away: number): TrackPoint[] => [
          ...run(10, offset),
          ...run(away, offset + 10).map((point) => ({ ...point, lat: point.lat + 2 })),
          ...run(10, offset + 10 + away),
        ];

        await t.step('an excursion is left out of reads and of the summary', async () => {
          await registry.touch('t-out', {});
          await registry.appendPoints('t-out', excursion(0, 5));

          const read = await registry.readPoints('t-out');
          assertEquals(read.points, 20);
          assertEquals(allPoints(read.segments).some((point) => point.lat > 59), false);
          assertEquals(read.segments.length, 1);

          const summary = await registry.summary('t-out');
          assertEquals(summary.points, 20);
          assertEquals(summary.bbox!.north < 59, true);

          const simplified = await registry.readPoints('t-out', { tolerance: 0.00001 });
          assertEquals(allPoints(simplified.segments).some((point) => point.lat > 59), false);
        });

        await t.step('a read asking for rejected fixes gets them, marked', async () => {
          const read = await registry.readPoints('t-out', { rejected: true });
          const away = allPoints(read.segments).filter((point) => point.lat > 59);

          assertEquals(read.points, 25);
          assertEquals(away.length, 5);
          assertEquals(away.every((point) => point.rejected === 'excursion'), true);
          assertEquals(allPoints(read.segments).filter((point) => point.rejected).length, 5);
        });

        await t.step('the byte-stream view keeps rejected fixes, marked', async () => {
          const handle = await registry.open('t-out', {}, 'r');
          const lines: TrackPoint[] = [];

          try {
            for (let chunk = await handle.read(1); chunk.length > 0; chunk = await handle.read(1)) {
              lines.push(JSON.parse(new TextDecoder().decode(chunk)) as TrackPoint);
            }
          } finally {
            await handle.close();
          }

          assertEquals(lines.length, 25);
          assertEquals(lines.filter((point) => point.rejected === 'excursion').length, 5);
        });

        await t.step('a backdated append that brings the track back makes an excursion of what it left', async () => {
          // The way out and the run away first; nothing comes back yet, so the leap out is a jump.
          const points = excursion(1000, 5);
          await registry.touch('t-late', {});
          await registry.appendPoints('t-late', points.slice(0, 15));
          assertEquals((await registry.readPoints('t-late')).points, 15);
          assertEquals((await registry.readPoints('t-late')).segments.length, 2);

          // Later, the rest arrives: the track comes back, and what was away is rejected.
          await registry.appendPoints('t-late', points.slice(15));
          const read = await registry.readPoints('t-late');
          assertEquals(read.points, 20);
          assertEquals(read.segments.length, 1);
          assertEquals((await registry.summary('t-late')).points, 20);

          // Deleting the way back takes the excursion away again.
          await registry.deletePoints('t-late', { from: points[15].ts });
          assertEquals((await registry.readPoints('t-late')).points, 15);
          assertEquals((await registry.summary('t-late')).points, 15);
        });

        await t.step('a jump that does not come back cuts the line and keeps its fixes', async () => {
          // Fifteen kilometres in a second, then steady going there.
          await registry.touch('t-jump', {});
          await registry.appendPoints('t-jump', [...run(10), ...run(10, 10).map((point) => ({ ...point, lat: point.lat + 0.135 }))]);

          const read = await registry.readPoints('t-jump');
          assertEquals(read.points, 20);
          assertEquals(read.segments.map((segment) => segment.points.length), [10, 10]);

          const simplified = await registry.readPoints('t-jump', { tolerance: 0.00001, still: {} });
          assertEquals(simplified.segments.length, 2);
        });

        const at = (point: TrackPoint) => ({ from: point.ts, to: new Date(Date.parse(point.ts) + 1).toISOString() });

        await t.step('a read of the rejected fixes alone gets each run of them on its own', async () => {
          const read = await registry.readPoints('t-out', { rejected: 'only' });
          assertEquals(read.points, 5);
          assertEquals(read.segments.length, 1);
          assertEquals(allPoints(read.segments).every((point) => point.rejected === 'excursion'), true);

          // A fix rejected by hand on the way out is a run of its own.
          const first = excursion(0, 5)[3];
          assertEquals(await registry.markPoints('t-out', at(first), 'reject'), 1);
          const runs = await registry.readPoints('t-out', { rejected: 'only' });
          assertEquals(runs.segments.map((segment) => segment.points.length), [1, 5]);
          assertEquals(runs.segments[0].points[0], { ...first, rejected: 'manual', manual: 'reject' });
          assertEquals((await registry.summary('t-out')).points, 19);

          assertEquals(await registry.markPoints('t-out', at(first), null), 1);
          assertEquals((await registry.summary('t-out')).points, 20);
        });

        await t.step('an excursion a person accepts is read and summed, until the verdict is cleared', async () => {
          const away = excursion(0, 5).slice(10, 15);
          const range = { from: away[0].ts, to: at(away[4]).to };

          assertEquals(await registry.markPoints('t-out', range, 'accept'), 5);
          assertEquals(await registry.markPoints('t-out', range, 'accept'), 0);

          const read = await registry.readPoints('t-out');
          assertEquals(read.points, 25);
          const back = allPoints(read.segments).filter((point) => point.lat > 59);
          assertEquals(back.every((point) => point.manual === 'accept' && point.rejected === undefined), true);
          assertEquals((await registry.summary('t-out')).points, 25);
          assertEquals((await registry.summary('t-out')).bbox!.north > 59, true);
          assertEquals((await registry.readPoints('t-out', { rejected: 'only' })).points, 0);

          // A still read takes them as ground, not as a spike, and the way back from them too.
          const far = (read: TrackReadResult) => allPoints(read.segments).filter((point) => point.lat > 59).length;
          assertEquals((await registry.readPoints('t-out', { still: {} })).points, 25);
          const simplified = await registry.readPoints('t-out', { tolerance: 0.00001 });
          assertEquals(far(simplified) > 0, true);
          assertEquals(far(await registry.readPoints('t-out', { tolerance: 0.00001, still: {} })), far(simplified));
          assertEquals(
            (await registry.readPoints('t-out', { tolerance: 0.00001, still: {} })).segments.flatMap((segment) => segment.points).every((point) => point.manual === undefined),
            true,
          );

          assertEquals(await registry.markPoints('t-out', {}, null), 5);
          assertEquals((await registry.readPoints('t-out')).points, 20);
          assertEquals((await registry.summary('t-out')).points, 20);
        });

        await t.step('a lone fix a person accepts is not dropped as a spike', async () => {
          const points = excursion(3000, 1);
          await registry.touch('t-vouched', {});
          await registry.appendPoints('t-vouched', points);
          assertEquals((await registry.readPoints('t-vouched', { still: {} })).points, 20);
          assertEquals(await registry.markPoints('t-vouched', at(points[10]), 'accept'), 1);

          const far = (read: TrackReadResult) => allPoints(read.segments).filter((point) => point.lat > 59).length;
          assertEquals(far(await registry.readPoints('t-vouched', { still: {} })), 1);
          assertEquals(far(await registry.readPoints('t-vouched', { tolerance: 0.00001, still: {} })), 1);
        });

        await t.step("a rejected excursion a person rejects too is the rules' again once cleared", async () => {
          const away = excursion(0, 5).slice(10, 15);
          const range = { from: away[0].ts, to: at(away[4]).to };

          assertEquals(await registry.markPoints('t-out', range, 'reject'), 5);
          const marked = allPoints((await registry.readPoints('t-out', { rejected: true })).segments).filter((point) => point.lat > 59);
          assertEquals(marked.every((point) => point.rejected === 'manual'), true);

          assertEquals(await registry.markPoints('t-out', range, null), 5);
          const judged = allPoints((await registry.readPoints('t-out', { rejected: true })).segments).filter((point) => point.lat > 59);
          assertEquals(judged.every((point) => point.rejected === 'excursion' && point.manual === undefined), true);
          assertEquals((await registry.summary('t-out')).points, 20);
        });

        await t.step('the rules judge a track without the fixes a person rejected', async () => {
          // The fix the jump lands on rejected by hand: the next one is where the line is cut now.
          const points = [...run(10, 2000), ...run(10, 2010).map((point) => ({ ...point, lat: point.lat + 0.135 }))];
          await registry.touch('t-hand', {});
          await registry.appendPoints('t-hand', points);
          assertEquals(await registry.markPoints('t-hand', at(points[10]), 'reject'), 1);

          const read = await registry.readPoints('t-hand');
          assertEquals(read.segments.map((segment) => segment.points.length), [10, 9]);
          assertEquals((await registry.readPoints('t-hand', { tolerance: 0.00001 })).segments.length, 2);
        });

        await t.step('a verdict on a track that does not exist fails', async () => {
          await assertRejects(() => registry.markPoints('nope', {}, 'reject'), Error, 'no track found');
        });

        await t.step('limit caps the vertices and says so', async () => {
          const result = await registry.readPoints('t4', { limit: 20 });

          assertEquals(result.points <= 20, true);
          assertEquals(result.truncated, true);
        });

        await t.step('deleting a range updates the summary', async () => {
          const removed = await registry.deletePoints('t4', {
            from: new Date(BASE + 100_000).toISOString(),
          });

          assertEquals(removed, 100);

          const summary = await registry.summary('t4');

          assertEquals(summary.points, 100);
          assertEquals(summary.lastTs, new Date(BASE + 99_000).toISOString());
        });

        // Run together rather than in turn: appends must not lose each other's count, and an
        // append must not deadlock against a delete.
        await t.step('concurrent appends and a delete keep the summary honest', async () => {
          await registry.touch('busy', {});

          await Promise.all(Array.from({ length: 20 }, (_, batch) => registry.appendPoints('busy', run(5, batch * 5))));
          assertEquals((await registry.summary('busy')).points, 100);

          // The deleted range and the appended one are disjoint, so the total is arithmetic
          // rather than a race even though the writes overlap.
          await Promise.all([
            registry.deletePoints('busy', { from: new Date(BASE).toISOString(), to: new Date(BASE + 10_000).toISOString() }),
            ...Array.from({ length: 10 }, (_, batch) => registry.appendPoints('busy', run(5, 100 + batch * 5))),
          ]);

          assertEquals((await registry.summary('busy')).points, 100 - 10 + 50);
          await registry.delete('busy');
        });

        await t.step('a relay event on a bound routing key appends a point', async () => {
          await registry.touch('t7', { routingKeys: ['tracker.live'] });
          router.publish('tracker.live', { lat: 57.71, lng: 11.98, ts: new Date(BASE).toISOString() });

          // The relay handler is async; give it a turn.
          await new Promise((resolve) => setTimeout(resolve, 50));

          assertEquals((await registry.summary('t7')).points, 1);
        });

        await t.step('a pattern binding appends from every key it covers', async () => {
          await registry.touch('t8', { routingKeys: ['tracker.#'] });
          router.publish('tracker.live', { lat: 57.71, lng: 11.98, ts: new Date(BASE).toISOString() });
          router.publish('tracker.boat.live', { lat: 57.72, lng: 11.99, ts: new Date(BASE + 1000).toISOString() });
          router.publish('other.live', { lat: 57.73, lng: 11.97, ts: new Date(BASE + 2000).toISOString() });

          await waitFor(async () => (await registry.summary('t8')).points >= 2);

          assertEquals((await registry.summary('t8')).points, 2);
        });

        await t.step('the byte-stream view yields points as JSONL', async () => {
          const handle = await registry.open('t1', {}, 'r');

          try {
            const chunk = await handle.read(1);
            const point = JSON.parse(new TextDecoder().decode(chunk)) as TrackPoint;

            assertEquals(point.ts, new Date(BASE).toISOString());
          } finally {
            await handle.close();
          }
        });

        await t.step('writing to the handle appends points', async () => {
          const handle = await registry.open('t8', {}, 'w');

          try {
            await handle.write(new TextEncoder().encode(
              run(3, 0).map((point) => JSON.stringify(point)).join('\n') + '\n',
            ));
          } finally {
            await handle.close();
          }

          assertEquals((await registry.summary('t8')).points, 3);
        });

        await t.step('a write split mid-line still appends every point', async () => {
          const text = run(4, 20).map((point) => JSON.stringify(point)).join('\n') + '\n';
          // A shell redirect writes fixed-size chunks and will cut a line in half.
          const cut = Math.floor(text.length / 2);
          const handle = await registry.open('t9', {}, 'w');

          try {
            await handle.write(new TextEncoder().encode(text.slice(0, cut)));
            await handle.write(new TextEncoder().encode(text.slice(cut)));
          } finally {
            await handle.close();
          }

          assertEquals((await registry.summary('t9')).points, 4);
        });

        await t.step('a final line with no newline is flushed on close', async () => {
          const handle = await registry.open('t10', {}, 'w');

          try {
            await handle.write(new TextEncoder().encode(JSON.stringify(run(1, 30)[0])));
          } finally {
            await handle.close();
          }

          assertEquals((await registry.summary('t10')).points, 1);
        });

        await t.step('a point without lat/lng is rejected', async () => {
          await assertRejects(
            () => registry.appendPoints('t1', [{ lat: Number.NaN, lng: 0, ts: new Date(BASE).toISOString() }]),
            Error,
            'numeric lat and lng',
          );
        });

        await t.step('reading a track that does not exist fails', async () => {
          await assertRejects(() => registry.summary('nope'), Error, 'no track found');
        });

        await t.step('delete removes the track and its points', async () => {
          assertEquals(await registry.delete('t8'), true);
          assertEquals(await registry.exists('t8'), false);
          assertEquals(await registry.delete('t8'), false);
        });

        await t.step('list and count cover every track', async () => {
          const ids: string[] = [];
          for await (const id of await registry.list()) ids.push(id);

          assertEquals(ids.sort(), [
            't-gap',
            't-hand',
            't-jump',
            't-late',
            't-lone',
            't-out',
            't-still',
            't-vouched',
            't1',
            't10',
            't11',
            't2',
            't3',
            't4',
            't5',
            't6',
            't7',
            't9',
          ]);
          assertEquals(await registry.count(), 18);
        });
      } finally {
        await teardown();
      }
    },
  });
}
