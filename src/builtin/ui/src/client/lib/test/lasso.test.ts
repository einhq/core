import { assert, assertEquals } from '@std/assert';
import { bandRect, edgeSpeed, type LassoBox, lassoMode, lassoSelection, pastThreshold, sameHits, sectionHit, tileIndex, tilesInRect } from '../lasso.ts';
import { EMPTY_SECTION_SELECTION, isItemSelected, setItems, setSections } from '../section-selection.ts';

const header = { left: 0, top: 0, right: 1000, bottom: 64 };
const strip = { left: 0, top: 64, right: 1000, bottom: 275 };

Deno.test('a closed section is taken when the band touches its header', () => {
  assertEquals(sectionHit({ left: 990, top: 60, right: 1200, bottom: 62 }, { header, strip }), true);
  assertEquals(sectionHit({ left: 1001, top: 0, right: 1200, bottom: 300 }, { header, strip }), false);
});

Deno.test('a closed section is taken when the band covers at least half of its strip', () => {
  // The lower 60% of the strip across its whole width: taken, its header untouched.
  assertEquals(sectionHit({ left: 0, top: 148, right: 1000, bottom: 300 }, { header, strip }), true);
  // A sliver along its bottom edge is not.
  assertEquals(sectionHit({ left: 0, top: 250, right: 1000, bottom: 300 }, { header, strip }), false);
  // The whole height of the strip but under half its width is not either.
  assertEquals(sectionHit({ left: 0, top: 100, right: 400, bottom: 300 }, { header, strip }), false);
});

Deno.test('the band is drawn either way round, and starts once the pointer has moved 4 px', () => {
  assertEquals(bandRect({ x: 50, y: 80 }, { x: 10, y: 20 }), { left: 10, top: 20, right: 50, bottom: 80 });
  assertEquals(pastThreshold({ x: 0, y: 0 }, { x: 2, y: 3 }), false);
  assertEquals(pastThreshold({ x: 0, y: 0 }, { x: 0, y: 4 }), true);
});

Deno.test('shift adds, alt removes, otherwise the band replaces', () => {
  assertEquals(lassoMode({ shiftKey: false, altKey: false }), 'replace');
  assertEquals(lassoMode({ shiftKey: true, altKey: false }), 'add');
  assertEquals(lassoMode({ shiftKey: true, altKey: true }), 'remove');
});

Deno.test('the page scrolls near the edges, faster nearer them, at most 1,200 px a second', () => {
  const top = 100;
  const bottom = 900;
  assertEquals(edgeSpeed(500, top, bottom), 0);
  assertEquals(edgeSpeed(148, top, bottom), 0);
  assertEquals(edgeSpeed(124, top, bottom), -600);
  assertEquals(edgeSpeed(100, top, bottom), -1200);
  assertEquals(edgeSpeed(40, top, bottom), -1200);
  assertEquals(edgeSpeed(876, top, bottom), 600);
  assertEquals(edgeSpeed(2000, top, bottom), 1200);
});

Deno.test('replace, add and remove start from what was selected when the lasso started', () => {
  const base = setItems(setSections(EMPTY_SECTION_SELECTION, ['a'], true), 'open', ['/o/1.jpg'], true);
  const hits = { sections: new Set(['b']), items: new Map([['/o/2.jpg', 'open']]) };

  const replaced = lassoSelection(base, hits, 'replace');
  assertEquals([...replaced.sections], ['b']);
  assertEquals([isItemSelected(replaced, '/o/1.jpg', 'open'), isItemSelected(replaced, '/o/2.jpg', 'open')], [false, true]);

  const added = lassoSelection(base, hits, 'add');
  assertEquals([...added.sections].sort(), ['a', 'b']);
  assertEquals([isItemSelected(added, '/o/1.jpg', 'open'), isItemSelected(added, '/o/2.jpg', 'open')], [true, true]);

  const removed = lassoSelection(added, { sections: new Set(['a']), items: new Map([['/o/1.jpg', 'open']]) }, 'remove');
  assertEquals([...removed.sections], ['b']);
  assertEquals([isItemSelected(removed, '/o/1.jpg', 'open'), isItemSelected(removed, '/o/2.jpg', 'open')], [false, true]);
});

Deno.test('a band over a section selected whole takes its pictures out as exclusions', () => {
  const base = setSections(EMPTY_SECTION_SELECTION, ['open'], true);
  const removed = lassoSelection(base, { sections: new Set(), items: new Map([['/o/3.jpg', 'open']]) }, 'remove');
  assertEquals([...removed.sections], ['open']);
  assertEquals(isItemSelected(removed, '/o/3.jpg', 'open'), false);
  assertEquals(isItemSelected(removed, '/o/4.jpg', 'open'), true);
});

Deno.test('a frame that takes the same as the last is told apart from one that does not', () => {
  const a = { sections: new Set(['x']), items: new Map([['/1', 'o']]) };
  assertEquals(sameHits(a, { sections: new Set(['x']), items: new Map([['/1', 'o']]) }), true);
  assertEquals(sameHits(a, { sections: new Set(['x']), items: new Map([['/2', 'o']]) }), false);
});

/** A justified grid of `count` tiles, `perRow` to a row of 100 px, 3 px apart, with varying widths. */
const grid = (count: number, perRow: number): LassoBox[] =>
  Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / perRow);
    const column = index % perRow;
    return { left: column * 103, top: row * 103, width: 100, height: 100 };
  });

Deno.test('a band takes the tiles it touches, by row, as a pass over every tile would', () => {
  const boxes = grid(5000, 8);
  const index = tileIndex(boxes);
  assertEquals(index.rows.length, 625);
  const rect = { left: 150, top: 10_000, right: 420, bottom: 10_350 };
  const linear = boxes.flatMap((box, at) =>
    box.left <= rect.right && box.left + box.width >= rect.left && box.top <= rect.bottom && box.top + box.height >= rect.top ? [at] : []
  );
  assertEquals(tilesInRect(index, rect), linear);
  assertEquals(tilesInRect(index, { left: 0, top: -50, right: 5, bottom: -1 }), []);
  assertEquals(tilesInRect(index, { left: 0, top: 0, right: 2000, bottom: 2_000_000 }).length, 5000);
});

Deno.test('a band over a 5,000-picture group is looked up well inside a frame', () => {
  const index = tileIndex(grid(5000, 8));
  const started = performance.now();
  for (let frame = 0; frame < 600; frame++) tilesInRect(index, { left: 0, top: 0, right: 900, bottom: frame * 100 });
  const perFrame = (performance.now() - started) / 600;
  assert(perFrame < 4, `${perFrame.toFixed(2)} ms a frame`);
});

Deno.test('the parts of a group, one grid under another, index as one', () => {
  const first = grid(10, 4);
  const second = grid(6, 4).map((box) => ({ ...box, top: box.top + 400 }));
  const index = tileIndex([...first, ...second]);
  assertEquals(index.rows.map((row) => [row.start, row.end]), [[0, 4], [4, 8], [8, 10], [10, 14], [14, 16]]);
  assertEquals(tilesInRect(index, { left: 0, top: 390, right: 50, bottom: 420 }), [10]);
});
