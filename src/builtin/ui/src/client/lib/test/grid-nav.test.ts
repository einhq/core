import { assertEquals } from '@std/assert';
import { gridNeighbour, type TileBox } from '../grid-nav.ts';

/** Seven 100px tiles, three to a row: 0 1 2 / 3 4 5 / 6. */
const tiles: TileBox[] = Array.from({ length: 7 }, (_, index) => ({ left: (index % 3) * 100, top: Math.floor(index / 3) * 120, width: 100 }));

Deno.test('grid nav: left and right walk reading order and stop at the ends', () => {
  assertEquals(gridNeighbour(tiles, 2, 'ArrowRight'), 3);
  assertEquals(gridNeighbour(tiles, 3, 'ArrowLeft'), 2);
  assertEquals(gridNeighbour(tiles, 0, 'ArrowLeft'), null);
  assertEquals(gridNeighbour(tiles, 6, 'ArrowRight'), null);
});

Deno.test('grid nav: up and down keep the column', () => {
  assertEquals(gridNeighbour(tiles, 1, 'ArrowDown'), 4);
  assertEquals(gridNeighbour(tiles, 4, 'ArrowUp'), 1);
  assertEquals(gridNeighbour(tiles, 0, 'ArrowUp'), null);
  assertEquals(gridNeighbour(tiles, 6, 'ArrowDown'), null);
});

Deno.test('grid nav: a short last row is reached from past its end', () => {
  assertEquals(gridNeighbour(tiles, 5, 'ArrowDown'), 6);
  assertEquals(gridNeighbour(tiles, 6, 'ArrowUp'), 3);
});

Deno.test('grid nav: rows a pixel apart are one row; Home and End go to the ends', () => {
  const jittered = tiles.map((tile, index) => ({ ...tile, top: tile.top + (index % 2) * 0.5 }));
  assertEquals(gridNeighbour(jittered, 1, 'ArrowDown'), 4);
  assertEquals(gridNeighbour(tiles, 4, 'Home'), 0);
  assertEquals(gridNeighbour(tiles, 4, 'End'), 6);
  assertEquals(gridNeighbour([], 0, 'ArrowDown'), null);
});
