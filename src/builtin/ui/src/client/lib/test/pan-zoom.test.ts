/**
 * The sums a dragged and zoomed drawing is placed by: fitting it, centring a point, keeping it in
 * sight, and zooming about a point that stays where it is.
 */

import { assertAlmostEquals, assertEquals } from '@std/assert';
import { centredOn, clampView, fitScale, fitView, sameView, toDrawing, zoomedAbout } from '../pan-zoom.ts';

const box = { width: 400, height: 300 };

Deno.test('pan-zoom: a drawing fits as large as the box allows, never past full size or below the least', () => {
  assertEquals(fitScale({ width: 800, height: 300 }, box), 0.5);
  assertEquals(fitScale({ width: 100, height: 100 }, box), 1);
  assertEquals(fitScale({ width: 40_000, height: 300 }, box), 0.2);
  assertEquals(fitScale({ width: 40_000, height: 300 }, box, 0.05), 0.05);
  assertEquals(fitView({ width: 800, height: 300 }, box), { scale: 0.5, x: 0, y: 75 });
});

Deno.test('pan-zoom: a point centred, and the middle of the box kept on the drawing', () => {
  assertEquals(centredOn({ x: 100, y: 50 }, 2, box), { scale: 2, x: 0, y: 50 });
  const drawing = { width: 1000, height: 1000 };
  assertEquals(clampView({ scale: 1, x: 500, y: -2000 }, drawing, box), { scale: 1, x: 200, y: -850 });
  assertEquals(clampView({ scale: 1, x: -100, y: -100 }, drawing, box), { scale: 1, x: -100, y: -100 });
});

Deno.test('pan-zoom: zooming about a point keeps the drawing under it, and finds it again', () => {
  const view = { scale: 1, x: 10, y: 20 };
  const under = toDrawing(view, 200, 150);
  const zoomed = zoomedAbout(view, 2, 200, 150);
  const still = toDrawing(zoomed, 200, 150);
  assertAlmostEquals(still.x, under.x);
  assertAlmostEquals(still.y, under.y);
  assertEquals(sameView(zoomed, { ...zoomed, x: zoomed.x + 0.2 }), true);
  assertEquals(sameView(zoomed, { ...zoomed, scale: 2.5 }), false);
});
