import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { HAT_KITES, HAT_POINTS } from '../hat.ts';

type Point = [number, number];

const corners = (points: string): Point[] => points.split(' ').map((pair) => pair.split(',').map(Number) as Point);

const area = (polygon: Point[]): number =>
  Math.abs(polygon.reduce((sum, [x, y], i) => {
    const [nx, ny] = polygon[(i + 1) % polygon.length];
    return sum + x * ny - nx * y;
  }, 0)) / 2;

const contains = (polygon: Point[], [x, y]: Point): boolean => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

Deno.test('the eight kites cover the hat exactly', () => {
  const hat = corners(HAT_POINTS);
  const kites = HAT_KITES.map(corners);
  assertEquals(kites.length, 8);
  for (const kite of kites) {
    assertAlmostEquals(area(kite), Math.sqrt(3), 1e-3);
    const centre: Point = [kite.reduce((sum, [x]) => sum + x, 0) / 4, kite.reduce((sum, [, y]) => sum + y, 0) / 4];
    assert(contains(hat, centre), `kite ${kite.join(' ')} lies outside the hat`);
  }
  assertAlmostEquals(kites.reduce((sum, kite) => sum + area(kite), 0), area(hat), 1e-2);
});
