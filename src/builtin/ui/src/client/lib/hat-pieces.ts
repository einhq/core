import { hashString } from './hash-string.ts';
import { HAT_POINTS } from './hat.ts';
import { HAT_SCALE } from './hat-field.ts';
import { HAT_TILING, HAT_TILING_COVERED } from './hat-tiling.ts';

/** A box on a surface, in px: its left, top, width and height. */
export type HatPieceBox = [x: number, y: number, width: number, height: number];

/** One piece cut from the hat tiling. Its paths are in the px of its own box. */
export type HatPiece = {
  /** Where it lies on the surface: the bounds of its hats. */
  box: HatPieceBox;
  /** Its outline, as an SVG path: closed lines, one round each hole its hats leave. */
  outline: string;
  /** The part of its cells no other piece's hats reach into, where its content keeps clear of its edge. */
  clear: HatPieceBox;
  /** The edges its own hats share, as an SVG path: the tiles drawn inside it. */
  tiles: string;
  /** Its mirrored hats, about one in eight, as an SVG path. */
  mirrored: string;
};

/** Cells laid over a surface, and the cells each piece is cut over. */
export type HatPiecesLayout = {
  /** The surface, in px. */
  width: number;
  height: number;
  /** The grid's top left on the surface, in px. */
  origin?: [number, number];
  /** One cell's width and height, in px. */
  cell: [number, number];
  columns: number;
  rows: number;
  /** Each piece's cells, from the grid's top left. */
  pieces: { x: number; y: number; w: number; h: number }[];
  /**
   * The hats past the grid's edge go to the piece at that edge, so the pieces run on past it, for a
   * surface that cuts them straight there. Otherwise the outer edge follows the hats too.
   */
  toEdge?: boolean;
  /** Picks where on the tiling the surface is cut: one seed always cuts the same. */
  seed?: string;
};

type Lattice = readonly [a: number, b: number];
type Px = readonly [number, number];

const HALF_SQRT3 = Math.sqrt(3) / 2;

/**
 * The hat's corners on the triangular lattice the tiling lies on, x = a/2 and y = b·√3/2, so every
 * corner is a pair of integers. Its edge two units long is split at its middle, where a neighbour's
 * corner may sit, so two hats that meet share whole edges.
 */
const HAT: Lattice[] = (() => {
  const corners = HAT_POINTS.split(' ').map((pair): Lattice => {
    const [x, y] = pair.split(',').map(Number);
    return [Math.round(2 * x), Math.round(y / HALF_SQRT3)];
  });
  return corners.flatMap((corner, i): Lattice[] => {
    const next = corners[(i + 1) % corners.length];
    const long = Math.hypot((next[0] - corner[0]) / 2, (next[1] - corner[1]) * HALF_SQRT3) > 1.9;
    return long ? [corner, [(corner[0] + next[0]) / 2, (corner[1] + next[1]) / 2]] : [corner];
  });
})();

/** A lattice point as one number: the patch's corners lie within a < 4,080 and b < 2,030 of it. */
const keyOf = ([a, b]: Lattice): number => (a + 16) * 2048 + b + 16;
/** A directed edge as one number, exact below 2⁵³. */
const edgeOf = (from: number, to: number): number => from * 2 ** 23 + to;

/** The farthest a hat's corner lies from its centre, in `HAT_POINTS` units. */
const REACH = 3.2;

type LatticeHat = { corners: Lattice[]; keys: number[]; mirrored: boolean; cx: number; cy: number };

let decoded: LatticeHat[] | undefined;

/**
 * The patch's hats with their corners on the lattice, every one running the same way round, so an
 * edge two hats share is one's `u → v` and the other's `v → u`; and each one's centre, in units.
 */
function latticeHats(): LatticeHat[] {
  if (decoded) return decoded;
  decoded = [];
  for (let n = 0; n < HAT_TILING.length; n += 5) {
    const k = parseInt(HAT_TILING[n], 36);
    const i = parseInt(HAT_TILING.slice(n + 1, n + 3), 36);
    const j = parseInt(HAT_TILING.slice(n + 3, n + 5), 36);
    const mirrored = k >= 6;
    let corners = HAT.map(([a, b]): Lattice => [a, mirrored ? -b : b]);
    for (let turn = 0; turn < k % 6; turn++) corners = corners.map(([a, b]): Lattice => [(a - 3 * b) / 2, (a + b) / 2]);
    corners = corners.map(([a, b]): Lattice => [a + 2 * i + j, b + j]);
    if (mirrored) corners.reverse();
    let area = 0, cx = 0, cy = 0;
    for (let m = 0; m < corners.length; m++) {
      const [x0, y0] = [corners[m][0] / 2, corners[m][1] * HALF_SQRT3];
      const next = corners[(m + 1) % corners.length];
      const [x1, y1] = [next[0] / 2, next[1] * HALF_SQRT3];
      const cross = x0 * y1 - x1 * y0;
      area += cross;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
    }
    decoded.push({ corners, keys: corners.map(keyOf), mirrored, cx: cx / (3 * area), cy: cy / (3 * area) });
  }
  return decoded;
}

/**
 * How the patch lies on a `width` × `height` px surface: px per unit, as large as the header's field,
 * and the map from units to px, cut where `seed` says. A surface taller than wide lies along the
 * patch's long side, with its x along the patch's y (the tiling mirrored, which is a tiling as good);
 * past the patch's size the hats grow rather than leave bare ground.
 */
function surfaceOf(width: number, height: number, seed: string): { scale: number; toPx: (x: number, y: number) => Px } {
  const covered = HAT_TILING_COVERED;
  const turned = height > width;
  const across = turned ? covered.height : covered.width;
  const down = turned ? covered.width : covered.height;
  const scale = Math.max(HAT_SCALE, width / across, height / down);
  const hash = hashString(seed);
  const left = (turned ? covered.y : covered.x) + (hash % 1000) / 1000 * (across - width / scale);
  const top = (turned ? covered.x : covered.y) + (Math.floor(hash / 1000) % 1000) / 1000 * (down - height / scale);
  return { scale, toPx: turned ? (x, y) => [(y - left) * scale, (x - top) * scale] : (x, y) => [(x - left) * scale, (y - top) * scale] };
}

type Shown = { hat: LatticeHat; px: Px[]; bounds: [number, number, number, number]; owner: number };

/** A path of closed lines through `loops`, moved by `dx`, `dy`. */
const pathOf = (loops: Px[][], dx: number, dy: number): string =>
  loops.map((loop) => `M${loop.map(([x, y]) => `${(x - dx).toFixed(1)} ${(y - dy).toFixed(1)}`).join('L')}Z`).join('');

/** The part of polygon `corners` inside the box `[x0, y0, x1, y1]`, as Sutherland and Hodgman clip it. */
function clipToBox(corners: Px[], [x0, y0, x1, y1]: [number, number, number, number]): Px[] {
  const sides: { inside: (p: Px) => boolean; cross: (a: Px, b: Px) => Px }[] = [
    { inside: ([x]) => x >= x0, cross: (a, b) => [x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0])] },
    { inside: ([x]) => x <= x1, cross: (a, b) => [x1, a[1] + (b[1] - a[1]) * (x1 - a[0]) / (b[0] - a[0])] },
    { inside: ([, y]) => y >= y0, cross: (a, b) => [a[0] + (b[0] - a[0]) * (y0 - a[1]) / (b[1] - a[1]), y0] },
    { inside: ([, y]) => y <= y1, cross: (a, b) => [a[0] + (b[0] - a[0]) * (y1 - a[1]) / (b[1] - a[1]), y1] },
  ];
  let polygon = corners;
  for (const { inside, cross } of sides) {
    const kept: Px[] = [];
    for (let m = 0; m < polygon.length; m++) {
      const from = polygon[(m + polygon.length - 1) % polygon.length];
      const to = polygon[m];
      if (inside(to)) {
        if (!inside(from)) kept.push(cross(from, to));
        kept.push(to);
      } else if (inside(from)) kept.push(cross(from, to));
    }
    polygon = kept;
    if (polygon.length === 0) break;
  }
  return polygon;
}

/** The outline of the hats `mine` as closed lines of px corners, those where the line runs straight on left out. */
function outlineOf(shown: Shown[], mine: number[]): Px[][] {
  const own = new Set<number>();
  for (const at of mine) {
    const { keys } = shown[at].hat;
    for (let m = 0; m < keys.length; m++) own.add(edgeOf(keys[m], keys[(m + 1) % keys.length]));
  }
  const onward = new Map<number, number[]>();
  const corner = new Map<number, { px: Px; at: Lattice }>();
  for (const at of mine) {
    const { hat, px } = shown[at];
    for (let m = 0; m < hat.keys.length; m++) {
      const next = (m + 1) % hat.keys.length;
      const [u, v] = [hat.keys[m], hat.keys[next]];
      if (own.has(edgeOf(v, u))) continue;
      if (!onward.has(u)) onward.set(u, []);
      onward.get(u)!.push(v);
      corner.set(u, { px: px[m], at: hat.corners[m] });
      corner.set(v, { px: px[next], at: hat.corners[next] });
    }
  }
  const loops: Px[][] = [];
  for (const [start, out] of onward) {
    while (out.length > 0) {
      const loop = [start];
      for (let at = out.pop()!; at !== start; at = onward.get(at)!.pop()!) loop.push(at);
      const points = loop.map((key) => corner.get(key)!);
      loops.push(
        points.filter(({ at }, m) => {
          const before = points[(m + points.length - 1) % points.length].at;
          const after = points[(m + 1) % points.length].at;
          return (at[0] - before[0]) * (after[1] - at[1]) !== (at[1] - before[1]) * (after[0] - at[0]);
        }).map(({ px }) => px),
      );
    }
  }
  return loops;
}

/**
 * The tiling cut into `pieces` over a grid of cells, as large as the header's field: each hat goes to
 * the piece whose cells hold its centre, and a piece's outline is the edges its hats do not share
 * with one another, so two pieces that meet share one jagged line exactly. A piece that holds no hat
 * is `null`.
 *
 * Other pieces' hats reach into a piece's cells by up to about half a hat; `clear` is the box they
 * leave, found side by side, each such hat kept out across the side where that costs least.
 */
export function layoutHatPieces({ width, height, origin = [0, 0], cell, columns, rows, pieces, toEdge = false, seed = '' }: HatPiecesLayout): (HatPiece | null)[] {
  const { scale, toPx } = surfaceOf(width, height, seed);
  // A hat whose centre lies further out than this cannot reach the surface.
  const reach = REACH * scale;
  const covered = HAT_TILING_COVERED;
  const owners = Array.from({ length: rows }, () => new Array<number>(columns).fill(-1));
  pieces.forEach(({ x, y, w, h }, piece) => {
    for (let row = y; row < Math.min(rows, y + h); row++) for (let column = x; column < Math.min(columns, x + w); column++) owners[row][column] = piece;
  });

  const shown: Shown[] = [];
  for (const hat of latticeHats()) {
    // Past the box the patch covers it has gaps, and two hats overlap at its rim.
    if (hat.cx < covered.x - 1 || hat.cx > covered.x + covered.width + 1 || hat.cy < covered.y - 1 || hat.cy > covered.y + covered.height + 1) continue;
    const [cx, cy] = toPx(hat.cx, hat.cy);
    if (cx < -reach || cy < -reach || cx > width + reach || cy > height + reach) continue;
    let column = Math.floor((cx - origin[0]) / cell[0]);
    let row = Math.floor((cy - origin[1]) / cell[1]);
    if (toEdge) {
      column = Math.min(columns - 1, Math.max(0, column));
      row = Math.min(rows - 1, Math.max(0, row));
    }
    const owner = row >= 0 && row < rows && column >= 0 && column < columns ? owners[row][column] : -1;
    const px = hat.corners.map(([a, b]) => toPx(a / 2, b * HALF_SQRT3));
    const xs = px.map(([x]) => x);
    const ys = px.map(([, y]) => y);
    shown.push({ hat, px, bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], owner });
  }

  // Which shown hat runs along each directed edge, for the edges a piece's own hats share.
  const holder = new Map<number, number>();
  shown.forEach(({ hat: { keys } }, at) => {
    for (let m = 0; m < keys.length; m++) holder.set(edgeOf(keys[m], keys[(m + 1) % keys.length]), at);
  });

  return pieces.map(({ x, y, w, h }, piece): HatPiece | null => {
    const mine = shown.flatMap((each, at) => each.owner === piece ? [at] : []);
    if (mine.length === 0) return null;
    const cells: [number, number, number, number] = [origin[0] + x * cell[0], origin[1] + y * cell[1], origin[0] + (x + w) * cell[0], origin[1] + (y + h) * cell[1]];
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const at of mine) {
      const [x0, y0, x1, y1] = shown[at].bounds;
      left = Math.min(left, x0);
      top = Math.min(top, y0);
      right = Math.max(right, x1);
      bottom = Math.max(bottom, y1);
    }
    [left, top, right, bottom] = [Math.floor(left), Math.floor(top), Math.ceil(right), Math.ceil(bottom)];

    // How far other pieces' hats, and the ground's, reach into its cells, from the top, right, bottom and left.
    const reachIn = [0, 0, 0, 0];
    for (const other of shown) {
      const [x0, y0, x1, y1] = other.bounds;
      if (other.owner === piece || x1 <= cells[0] || x0 >= cells[2] || y1 <= cells[1] || y0 >= cells[3]) continue;
      const part = clipToBox(other.px, cells);
      if (part.length < 3) continue;
      const xs = part.map(([px]) => px);
      const ys = part.map(([, py]) => py);
      const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      // A sliver along a side is a shared edge, not a hat reaching in.
      if (maxX - minX < .5 || maxY - minY < .5) continue;
      const need = [maxY - cells[1], cells[2] - minX, cells[3] - minY, maxX - cells[0]];
      const side = need.indexOf(Math.min(...need));
      reachIn[side] = Math.max(reachIn[side], need[side]);
    }

    const tiles: string[] = [];
    for (const at of mine) {
      const { hat: { keys }, px } = shown[at];
      for (let m = 0; m < keys.length; m++) {
        const next = (m + 1) % keys.length;
        if (keys[m] > keys[next]) continue;
        const other = holder.get(edgeOf(keys[next], keys[m]));
        if (other === undefined || shown[other].owner !== piece) continue;
        tiles.push(`M${(px[m][0] - left).toFixed(1)} ${(px[m][1] - top).toFixed(1)}L${(px[next][0] - left).toFixed(1)} ${(px[next][1] - top).toFixed(1)}`);
      }
    }

    return {
      box: [left, top, right - left, bottom - top],
      outline: pathOf(outlineOf(shown, mine), left, top),
      clear: [
        cells[0] + reachIn[3] - left,
        cells[1] + reachIn[0] - top,
        Math.max(0, cells[2] - cells[0] - reachIn[1] - reachIn[3]),
        Math.max(0, cells[3] - cells[1] - reachIn[0] - reachIn[2]),
      ],
      tiles: tiles.join(''),
      mirrored: pathOf(mine.filter((at) => shown[at].hat.mirrored).map((at) => shown[at].px), left, top),
    };
  });
}
