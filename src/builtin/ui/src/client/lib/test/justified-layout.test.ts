/**
 * justifiedLayout: rows of pictures at their own aspect ratios, filled to the container.
 *
 * The assertion that matters most is the exact-integer one: a row whose tiles round
 * independently leaves a 1-2px sliver at the right edge, which is invisible in a
 * screenshot and unmistakable once every row does it.
 */

import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import {
  DEFAULT_ASPECT,
  defaultItemsPerRow,
  defaultRowHeight,
  displayAspect,
  justifiedLayout,
  LAST_ROW_FILL_THRESHOLD,
  squareColumns,
  squareLayout,
  tileRangeForVerticalWindow,
} from '../justified-layout.ts';

const OPTS = { containerWidth: 1000, targetRowHeight: 200, gap: 10 };

const rowsOf = (aspects: number[], opts = OPTS) => justifiedLayout(aspects, opts);

Deno.test('an empty list lays out to nothing', () => {
  const layout = justifiedLayout([], OPTS);
  assertEquals(layout.tiles, []);
  assertEquals(layout.rows, []);
  assertEquals(layout.height, 0);
});

Deno.test('a container with no width lays out to nothing rather than NaN', () => {
  for (const containerWidth of [0, -50, Number.NaN]) {
    const layout = justifiedLayout([1, 1, 1], { ...OPTS, containerWidth });
    assertEquals(layout.tiles.length, 0);
    assertEquals(layout.height, 0);
  }
});

Deno.test('every full row spans the container exactly', () => {
  const layout = rowsOf(Array.from({ length: 40 }, (_, i) => [1, 1.5, 0.75, 1.33][i % 4]));

  assert(layout.rows.length > 3, 'expected several rows');

  for (const row of layout.rows.slice(0, -1)) {
    const first = layout.tiles[row.firstIndex];
    const last = layout.tiles[row.firstIndex + row.count - 1];
    assertEquals(first.left, 0);
    assertEquals(last.left + last.width, OPTS.containerWidth);
  }
});

Deno.test('tiles in a row share a top and a height', () => {
  const layout = rowsOf(Array.from({ length: 25 }, (_, i) => 0.6 + (i % 7) * 0.3));

  for (const row of layout.rows) {
    for (let n = 0; n < row.count; n++) {
      const tile = layout.tiles[row.firstIndex + n];
      assertEquals(tile.top, row.top);
      assertEquals(tile.height, row.height);
    }
  }
});

Deno.test('a tile keeps its aspect ratio', () => {
  const aspects = [1, 1.5, 0.75, 2, 1.33, 0.8, 1.78, 1];
  const layout = rowsOf(aspects);

  for (const tile of layout.tiles) {
    assertAlmostEquals(tile.width / tile.height, aspects[tile.index], 0.02);
  }
});

Deno.test('twelve squares at 1000px fill five to a row', () => {
  const layout = rowsOf(Array.from({ length: 12 }, () => 1));

  // (1000 - 4*10) / 5 = 192
  assertEquals(layout.rows[0].count, 5);
  assertEquals(layout.rows[0].height, 192);
  assertEquals(layout.rows[1].count, 5);
  assertEquals(layout.rows.length, 3);
});

Deno.test('the last row keeps the target height and a ragged right edge', () => {
  const layout = rowsOf(Array.from({ length: 12 }, () => 1));
  const last = layout.rows[layout.rows.length - 1];
  const lastTile = layout.tiles[layout.tiles.length - 1];

  assertEquals(last.count, 2);
  assertEquals(last.height, OPTS.targetRowHeight);
  assert(lastTile.left + lastTile.width < OPTS.containerWidth, 'last row should not be stretched');
});

Deno.test('a single item is one ragged row at the target height', () => {
  const layout = rowsOf([1.5]);

  assertEquals(layout.rows.length, 1);
  assertEquals(layout.tiles.length, 1);
  assertEquals(layout.tiles[0].height, 200);
  assertEquals(layout.tiles[0].width, 300);
  assertEquals(layout.height, 200);
});

Deno.test('a last row below the fill threshold remains ragged', () => {
  const layout = rowsOf([1, 1, 1, 0.8]); // 790px including gaps
  const last = layout.tiles[layout.tiles.length - 1];

  assertEquals(LAST_ROW_FILL_THRESHOLD, 0.8);
  assertEquals(layout.rows[0].height, OPTS.targetRowHeight);
  assertEquals(last.left + last.width, 790);
});

Deno.test('a last row exactly at the fill threshold remains ragged', () => {
  const layout = rowsOf([1, 1, 1, 0.85]); // 800px including gaps
  const last = layout.tiles[layout.tiles.length - 1];

  assertEquals(layout.rows[0].height, OPTS.targetRowHeight);
  assertEquals(last.left + last.width, 800);
});

Deno.test('a last row above the fill threshold stretches exactly to the edge', () => {
  const layout = rowsOf([1, 1, 1, 0.9]); // 810px at target height
  const last = layout.tiles[layout.tiles.length - 1];

  assert(layout.rows[0].height > OPTS.targetRowHeight);
  assertEquals(last.left + last.width, OPTS.containerWidth);
});

Deno.test('an extreme panorama is clamped rather than flattening its row', () => {
  const layout = rowsOf([12, 1, 1, 1, 1, 1, 1, 1]);
  const panorama = layout.tiles[0];

  assert(panorama.width / panorama.height <= 3.01, 'aspect should be clamped to maxAspect');
  assert(panorama.height >= 100, `row collapsed to ${panorama.height}px`);
});

Deno.test('a garbage aspect falls back to the default rather than poisoning the row', () => {
  const layout = rowsOf([Number.NaN, 0, -2]);

  for (const tile of layout.tiles) {
    assertAlmostEquals(tile.width / tile.height, DEFAULT_ASPECT, 0.02);
  }
});

Deno.test('no row is taller than maxRowHeight', () => {
  const layout = rowsOf([0.55, 0.55, 2.9, 1, 1, 1, 1]);

  for (const row of layout.rows.slice(0, -1)) {
    assert(row.height <= OPTS.targetRowHeight * 1.6 + 1, `row is ${row.height}px`);
  }
});

Deno.test('order is preserved and rows move down the page', () => {
  const layout = rowsOf(Array.from({ length: 30 }, (_, i) => 0.7 + (i % 5) * 0.25));

  layout.tiles.forEach((tile, i) => assertEquals(tile.index, i));
  for (let i = 1; i < layout.tiles.length; i++) {
    assert(layout.tiles[i].top >= layout.tiles[i - 1].top);
  }
});

Deno.test('total height stops at the last row, with no trailing gutter', () => {
  const layout = rowsOf(Array.from({ length: 17 }, (_, i) => 1 + (i % 3) * 0.4));
  const last = layout.rows[layout.rows.length - 1];

  assertEquals(layout.height, last.top + last.height);
});

Deno.test('the same input lays out the same way twice', () => {
  const aspects = Array.from({ length: 23 }, (_, i) => 0.6 + (i % 9) * 0.28);
  assertEquals(rowsOf(aspects), rowsOf(aspects));
});

Deno.test('a vertical window returns every tile in its overlapping rows', () => {
  const layout = rowsOf(Array.from({ length: 30 }, () => 1));
  const middle = layout.rows[2];
  const range = tileRangeForVerticalWindow(layout.rows, middle.top + 10, middle.top + middle.height - 10);

  assertEquals(range, {
    firstIndex: middle.firstIndex,
    afterLastIndex: middle.firstIndex + middle.count,
  });
});

Deno.test('a vertical window includes rows touching either edge and no distant rows', () => {
  const layout = rowsOf(Array.from({ length: 30 }, () => 1));
  const second = layout.rows[1];
  const third = layout.rows[2];
  const range = tileRangeForVerticalWindow(layout.rows, second.top + second.height, third.top);

  assertEquals(range, {
    firstIndex: second.firstIndex,
    afterLastIndex: third.firstIndex + third.count,
  });
  assertEquals(tileRangeForVerticalWindow(layout.rows, layout.height + 1, layout.height + 20), undefined);
  assertEquals(tileRangeForVerticalWindow(layout.rows, 20, 19), undefined);
});

Deno.test('one more pixel of width never reorders the tiles', () => {
  const aspects = Array.from({ length: 23 }, (_, i) => 0.6 + (i % 9) * 0.28);

  for (let w = 900; w < 920; w++) {
    const layout = justifiedLayout(aspects, { ...OPTS, containerWidth: w });
    layout.tiles.forEach((tile, i) => assertEquals(tile.index, i));
  }
});

Deno.test('a zero gap is laid out edge to edge', () => {
  const layout = justifiedLayout(Array.from({ length: 12 }, () => 1), { ...OPTS, gap: 0 });

  assertEquals(layout.rows[0].height, 200);
  const row = layout.rows[0];
  const last = layout.tiles[row.firstIndex + row.count - 1];
  assertEquals(last.left + last.width, 1000);
});

Deno.test('defaultRowHeight aims taller on a phone than on a tablet', () => {
  assertEquals(defaultRowHeight(420), 210);
  assertEquals(defaultRowHeight(800), 170);
  assertEquals(defaultRowHeight(1400), 200);
});

Deno.test('a phone lays out two per row, wider containers fill to a row height', () => {
  assertEquals(defaultItemsPerRow(390), 2);
  assertEquals(defaultItemsPerRow(800), undefined);
});

Deno.test('fixed columns put exactly two of any shape on a row, filling the width', () => {
  const layout = justifiedLayout([1.5, 1.5, 2 / 3, 1.5, 2 / 3, 2 / 3], {
    containerWidth: 390,
    targetRowHeight: defaultRowHeight(390),
    gap: 3,
    itemsPerRow: 2,
  });
  assertEquals(layout.rows.map((row) => row.count), [2, 2, 2]);
  for (const row of layout.rows) {
    const last = layout.tiles[row.firstIndex + row.count - 1];
    assertEquals(last.left + last.width, 390);
  }
  // A landscape pair is shorter than a portrait pair: the shapes decide, not a target.
  assert(layout.rows[0].height < layout.rows[2].height);
});

Deno.test('fixed columns give a lone trailing item the whole row', () => {
  const layout = justifiedLayout([1.5, 1.5, 1.5], {
    containerWidth: 390,
    targetRowHeight: defaultRowHeight(390),
    gap: 3,
    itemsPerRow: 2,
  });
  assertEquals(layout.rows.length, 2);
  assertEquals(layout.rows[1].count, 1);
  assertEquals(layout.tiles[2].width, 390);
  assertEquals(layout.tiles[2].height, 260);
});

/** displayAspect: the display frame from the stored raster, its rotation and its pixel aspect. */
Deno.test('displayAspect swaps the axes at 90 and 270', () => {
  assertAlmostEquals(displayAspect({ width: 4000, height: 3000, angle: 90 })!, 3 / 4, 0.001);
  assertAlmostEquals(displayAspect({ width: 4000, height: 3000, angle: 270 })!, 3 / 4, 0.001);
});

Deno.test('displayAspect passes through at 0 and 180', () => {
  assertAlmostEquals(displayAspect({ width: 4000, height: 3000 })!, 4 / 3, 0.001);
  assertAlmostEquals(displayAspect({ width: 4000, height: 3000, angle: 0 })!, 4 / 3, 0.001);
  assertAlmostEquals(displayAspect({ width: 4000, height: 3000, angle: 180 })!, 4 / 3, 0.001);
});

Deno.test('displayAspect applies the pixel aspect ratio before the rotation', () => {
  // The AVCHD case: a 1440x1080 raster of a 16:9 picture. Without the ratio the grid lays a
  // whole album out at 4:3 and reflows every row as the first frames decode and measure
  // themselves (`MediaTile`'s onMeasure) — see
  // ein/core#208.
  assertAlmostEquals(displayAspect({ width: 1440, height: 1080, sar: 4 / 3 })!, 16 / 9, 0.001);
  assertAlmostEquals(displayAspect({ width: 1440, height: 1080, sar: 4 / 3, angle: 90 })!, 9 / 16, 0.001);
  // A ratio of 1, or none, is every still and most video.
  assertAlmostEquals(displayAspect({ width: 4000, height: 3000, sar: 1 })!, 4 / 3, 0.001);
  assertAlmostEquals(displayAspect({ width: 4000, height: 3000, sar: 0 })!, 4 / 3, 0.001);
});

Deno.test('displayAspect is undefined without dimensions', () => {
  assertEquals(displayAspect({}), undefined);
  assertEquals(displayAspect({ width: 100 }), undefined);
  assertEquals(displayAspect({ width: 0, height: 0 }), undefined);
});

Deno.test('squareLayout: fixed columns of squares, a full row ending on the width', () => {
  const layout = squareLayout(7, { containerWidth: 306, columns: 3, gap: 3 });
  assertEquals(layout.rows.length, 3);
  assertEquals(layout.tiles.slice(0, 3).map((t) => [t.left, t.width, t.height]), [[0, 100, 100], [103, 100, 100], [206, 100, 100]]);
  assertEquals(layout.tiles[3].top, 103);
  assertEquals(layout.height, 306);
});

Deno.test('squareLayout: a short last row keeps the same squares', () => {
  const layout = squareLayout(4, { containerWidth: 306, columns: 3, gap: 3 });
  const last = layout.tiles[3];
  assertEquals([last.left, last.width, last.height], [0, 100, 100]);
  assertEquals(layout.rows[1].count, 1);
});

Deno.test('squareColumns: the phone count on a phone, more as the width allows', () => {
  assertEquals(squareColumns(318, 3), 3);
  assertEquals(squareColumns(1160, 3), 6);
  assertEquals(squareColumns(318, 5), 5);
  assertEquals(squareColumns(1160, 5), 11);
});
