import { assert, assertAlmostEquals, assertEquals, assertNotEquals } from '@std/assert';
import { type HatPiece, type HatPiecesLayout, layoutHatPieces } from '../hat-pieces.ts';

type Point = [number, number];

/** A path's closed lines, as corners on the surface: the piece's box moved back where it lies. */
const loopsOf = (path: string, [left, top]: [number, number]): Point[][] =>
  path.split('M').filter(Boolean).map((loop) =>
    loop.replace('Z', '').split('L').map((pair) => {
      const [x, y] = pair.split(' ').map(Number);
      return [x + left, y + top] as Point;
    })
  );

/** Whether `point` lies inside the closed lines, each crossing turning inside to outside. */
const inside = (loops: Point[][], [x, y]: Point): boolean => {
  let within = false;
  for (const corners of loops) {
    for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
      const [xi, yi] = corners[i];
      const [xj, yj] = corners[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) within = !within;
    }
  }
  return within;
};

const outlines = (pieces: (HatPiece | null)[]): Point[][][] => pieces.map((piece) => piece ? loopsOf(piece.outline, [piece.box[0], piece.box[1]]) : []);

/** A wall of seven cards over twelve columns and ten rows, as a dashboard packs them. */
const WALL: HatPiecesLayout = {
  width: 1920,
  height: 1080,
  cell: [160, 108],
  columns: 12,
  rows: 10,
  pieces: [
    { x: 0, y: 0, w: 4, h: 3 },
    { x: 4, y: 0, w: 6, h: 5 },
    { x: 10, y: 0, w: 2, h: 2 },
    { x: 10, y: 2, w: 2, h: 3 },
    { x: 0, y: 3, w: 4, h: 7 },
    { x: 4, y: 5, w: 4, h: 5 },
    { x: 8, y: 5, w: 4, h: 5 },
  ],
  toEdge: true,
  seed: 'dashboard:Hallway',
};

Deno.test('pieces that meet share their edge: every point of the grid is in one piece, none in two', () => {
  const shapes = outlines(layoutHatPieces(WALL));
  for (let i = 0; i < 1500; i++) {
    const point: Point = [(i * 37.3) % 1920 + 0.31, (i * 13.7) % 1080 + 0.17];
    assertEquals(shapes.filter((loops) => inside(loops, point)).length, 1, `${point} is in no piece or in two`);
  }
});

Deno.test('to the edge, the pieces cover the surface to its corners; otherwise the hats past the grid are bare', () => {
  const corners: Point[] = [[1, 1], [1919, 1], [1, 1079], [1919, 1079]];
  const toEdge = outlines(layoutHatPieces(WALL));
  for (const point of corners) assertEquals(toEdge.filter((loops) => inside(loops, point)).length, 1, `the corner ${point} is bare`);

  // A grid 60 px in from every side: a hat reaches past it by at most about 24 px.
  const inset = outlines(layoutHatPieces({ ...WALL, origin: [60, 60], cell: [150, 96], toEdge: false }));
  for (const point of [[5, 5], [1915, 540], [960, 1075]] as Point[]) {
    assertEquals(inset.filter((loops) => inside(loops, point)).length, 0, `${point}, past the grid, is in a piece`);
  }
});

Deno.test("a piece's clear box holds nothing of another piece", () => {
  const pieces = layoutHatPieces(WALL);
  const shapes = outlines(pieces);
  pieces.forEach((piece, at) => {
    assert(piece, `piece ${at} holds no hat`);
    const [x, y, width, height] = piece.clear;
    assert(width > 200 && height > 150, `piece ${at}'s clear box is ${width} × ${height}`);
    for (let i = 0; i < 300; i++) {
      const point: Point = [piece.box[0] + x + ((i * 0.618) % 1) * width, piece.box[1] + y + ((i * 0.377) % 1) * height];
      const holders = shapes.flatMap((loops, other) => inside(loops, point) ? [other] : []);
      assertEquals(holders, [at], `${point} in piece ${at}'s clear box is in ${holders}`);
    }
  });
});

Deno.test('a piece whose cells are one block is one outline, with its tiles and mirrored hats inside it', () => {
  for (const piece of layoutHatPieces(WALL)) {
    assert(piece);
    assertEquals(piece.outline.split('M').length - 1, 1);
    assert(piece.tiles.length > 0);
    assert(piece.mirrored.split('M').length - 1 >= 1);
  }
});

Deno.test('one seed always cuts the same, and another cuts elsewhere', () => {
  assertEquals(layoutHatPieces(WALL), layoutHatPieces(WALL));
  assertNotEquals(layoutHatPieces(WALL)[0]?.outline, layoutHatPieces({ ...WALL, seed: 'dashboard:Kitchen' })[0]?.outline);
});

Deno.test("the hats are the header field's size on a wide surface and a tall one alike", () => {
  // A hat's short edges are one unit long: 7.35 px at the header field's size.
  const shortest = (layout: HatPiecesLayout) =>
    Math.min(
      ...layoutHatPieces(layout).flatMap((piece) => loopsOf(piece!.tiles.replaceAll(/(?=M)/g, ''), [0, 0]).map(([[x0, y0], [x1, y1]]) => Math.hypot(x1 - x0, y1 - y0))),
    );
  assertAlmostEquals(shortest(WALL), 7.35, 0.15);
  const phone: HatPiecesLayout = {
    width: 358,
    height: 1600,
    cell: [179, 111],
    columns: 2,
    rows: 14,
    pieces: [{ x: 0, y: 0, w: 2, h: 7 }, { x: 0, y: 7, w: 2, h: 7 }],
    toEdge: true,
  };
  assertAlmostEquals(shortest(phone), 7.35, 0.15);
});
