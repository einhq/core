import { assert, assertEquals } from '@std/assert';
import { stripLayout, stripSample } from '../justified-layout.ts';

const OPTS = { containerWidth: 1000, rowHeight: 104, rows: 2, gap: 3 };

const rowsOf = (tiles: { row: number; left: number; width: number }[]) => {
  const rows = new Map<number, { left: number; width: number }[]>();
  for (const tile of tiles) rows.set(tile.row, [...(rows.get(tile.row) ?? []), tile]);
  return [...rows.values()];
};

Deno.test('a strip is always its rows tall, however few pictures it has', () => {
  assertEquals(stripLayout([], OPTS).height, 2 * 104 + 3);
  assertEquals(stripLayout([1.5], OPTS).height, 2 * 104 + 3);
  assertEquals(stripLayout(Array(500).fill(1.5), OPTS).height, 2 * 104 + 3);
});

Deno.test('a full strip fills both rows exactly to the width', () => {
  const aspects = Array.from({ length: 200 }, (_, n) => [1.5, 0.75, 1.33, 1, 1.78][n % 5]);
  const { tiles } = stripLayout(aspects, OPTS);
  const rows = rowsOf(tiles);
  assertEquals(rows.length, 2);
  for (const row of rows) {
    const last = row[row.length - 1];
    assertEquals(row[0].left, 0);
    assertEquals(last.left + last.width, 1000);
    // Neighbours are one gap apart.
    for (let n = 1; n < row.length; n++) assertEquals(row[n].left - (row[n - 1].left + row[n - 1].width), 3);
  }
  assert(tiles.every((tile) => tile.height === 104));
});

Deno.test('no picture in a full row is stretched or squeezed past the clamp', () => {
  const aspects = Array.from({ length: 300 }, (_, n) => [2.4, 0.6, 1.5, 0.55, 2.2, 1][n % 6]);
  const { tiles } = stripLayout(aspects, OPTS);
  for (const tile of tiles) {
    const natural = Math.min(Math.max(aspects[tile.index], 0.5), 2.5) * 104;
    const factor = tile.width / natural;
    assert(factor >= 0.74 && factor <= 1.36, `tile ${tile.index} stretched by ${factor}`);
  }
});

Deno.test('a panorama is cropped to the widest shape a strip tile takes', () => {
  const { tiles } = stripLayout([8, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5], OPTS);
  const panorama = tiles.find((tile) => tile.index === 0)!;
  assert(panorama.width <= 2.5 * 104 * 1.36, `the panorama is ${panorama.width} px wide`);
  assertEquals(panorama.height, 104);
});

Deno.test('a strip too short to fill keeps the pictures at their own widths', () => {
  const { tiles } = stripLayout([1.5, 1], OPTS);
  assertEquals(tiles.map((tile) => [tile.index, tile.row, tile.left, tile.width]), [[0, 0, 0, 156], [1, 0, 159, 104]]);
});

Deno.test('what a strip leaves out is what the "+N" counts, and the shown pictures span the group', () => {
  const total = 400;
  const { tiles } = stripLayout(Array(total).fill(1.5), OPTS);
  assert(tiles.length < total);
  // The first is the group's first, and the last is near its end: sampled evenly, not cut off.
  assertEquals(tiles[0].index, 0);
  assert(tiles[tiles.length - 1].index > total * 0.8, `the last shown is ${tiles[tiles.length - 1].index}`);
  // In order, each shown once.
  assertEquals(tiles.map((tile) => tile.index), [...new Set(tiles.map((tile) => tile.index))].sort((a, b) => a - b));
});

Deno.test('sampling is even and the same every time', () => {
  assertEquals(stripSample(100, 10), [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
  assertEquals(stripSample(3, 10), [0, 1, 2]);
  assertEquals(stripSample(7, 3), [0, 2, 4]);
  assertEquals(stripSample(5, 0), []);
  const aspects = Array.from({ length: 97 }, (_, n) => 0.6 + (n * 37 % 19) / 10);
  assertEquals(stripLayout(aspects, OPTS), stripLayout(aspects, OPTS));
});
