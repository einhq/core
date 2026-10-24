import { hashString } from './hash-string.ts';
import { HAT_POINTS } from './hat.ts';
import { HAT_TILING, HAT_TILING_COVERED } from './hat-tiling.ts';
import { luminanceAt, type LuminanceMap } from './image-luminance.ts';

type Point = readonly [number, number];

/**
 * What a field is behind: a header band; the whole background behind other content; the bar of
 * buttons at a dialog's foot; a cover photo; or the left of a header band whose right is a cover
 * photo.
 */
export type HatFieldKind = 'band' | 'backdrop' | 'foot' | 'cover' | 'wedge';

/** One tile of a field, drawn on its own so that it can be animated on its own. */
export type HatTile = {
  /** Its outline, as an SVG path. */
  d: string;
  /** Its middle, in the field's pixels. */
  x: number;
  y: number;
  /** Its fill's opacity, darkening included; 0 over a cover. */
  fill: number;
  /**
   * How much of it shows, for its outline: 1, or less towards the darkened foot of a band or a wedge
   * and towards a wedge's edge.
   */
  shade: number;
  /**
   * Whether it may light up now and then: in a band only above the darkened foot and clear of the
   * title, in a wedge only in its upper part; never at a dialog's foot or over a cover.
   */
  glint: boolean;
  /** A number in [0, 1) of its own, for what varies from tile to tile, such as an entrance's timing. */
  jitter: number;
  /** Over a cover, how light the picture under it is: 0 dark, 1 light, and 0 when that is not known. */
  onLight: number;
  /** In a wedge, how much of the cover it hides: 1, or less as it nears the wedge's edge; 0 in any other field. */
  ground: number;
};

type HatFieldLayout = {
  /** The tiles, in no particular order. */
  tiles: HatTile[];
  /** A hat's mean width, in pixels. */
  hatSize: number;
};

/** Pixels per `HAT_POINTS` unit: a hat about 38 px across. */
const SCALE = 7.35;
/** A hat's mean width in `HAT_POINTS` units, over its twelve orientations. */
const HAT_WIDTH = 5.17;
/**
 * The largest field, in `HAT_POINTS` units, whose cut from the patch stays put as it grows: about
 * 2,400 × 370 px. A larger one moves the cut to fit.
 */
const STEADY = { width: 330, height: 50 };

const HAT: Point[] = HAT_POINTS.split(' ').map((pair) => pair.split(',').map(Number) as unknown as Point);
const HALF_SQRT3 = Math.sqrt(3) / 2;

type Hat = { corners: Point[]; mirrored: boolean };

let decoded: Hat[] | undefined;

/** The patch's hats, decoded on first use. */
function tiling(): Hat[] {
  if (decoded) return decoded;
  decoded = [];
  for (let n = 0; n < HAT_TILING.length; n += 5) {
    const k = parseInt(HAT_TILING[n], 36);
    const i = parseInt(HAT_TILING.slice(n + 1, n + 3), 36);
    const j = parseInt(HAT_TILING.slice(n + 3, n + 5), 36);
    const angle = (k % 6) * Math.PI / 3;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const flip = k >= 6 ? -1 : 1;
    const x = i + j / 2;
    const y = j * HALF_SQRT3;
    decoded.push({
      mirrored: k >= 6,
      corners: HAT.map(([px, py]) => [x + cos * px - sin * py * flip, y + sin * px + cos * py * flip] as const),
    });
  }
  return decoded;
}

/**
 * Relative luminances over which a cover's hat turns from the dark picture's outline to the light
 * one's: where a dark accent stands out more than a light grey does.
 */
const ON_LIGHT = [.24, .42] as const;

/**
 * A wedge's right edge: across `at` of the band's width at its middle, leaning right by `lean` px for
 * every px downwards, so the wedge is widest at its foot. Its hats dissolve into the cover over `fade`
 * hats either side of that line, each as a whole and moved up to half of `scatter` hats nearer or
 * further, so the fade is ragged.
 */
const WEDGE = { at: .34, lean: .65, fade: 3.2, scatter: 1.6 };

/**
 * The hats a `width` × `height` px field draws, in its own pixels, and how. `seed` picks where on
 * the patch the field is cut, so pages differ while each keeps its own.
 *
 * Every edge cuts the hats that run on past it, so a band is covered edge to edge.
 * Every tile is outlined and filled with the accent, a little more towards the upper right and on the
 * mirrored hats (about one in eight). The tiles come one by one (`HatTile`), so an entrance can move
 * each on its own. In a band the tiles darken towards the foot, each as a whole, so the title and controls there
 * stand on a quiet ground; a slim bar darkens less.
 *
 * Over a cover the field is only outlines, each told how light the picture is under it (`onLight`)
 * from `backdrop`, the cover's luminance. A wedge is a band's hats about a slanted line (`WEDGE`), whole ones on its left fading hat by hat (`ground`) into the cover
 * across it, lit towards the line's top.
 */
export function layoutHatField(width: number, height: number, seed: string, kind: HatFieldKind, backdrop?: LuminanceMap | null): HatFieldLayout {
  const covered = HAT_TILING_COVERED;
  // Past the patch's size the hats grow rather than leave bare ground.
  const scale = Math.max(SCALE, width / covered.width, height / covered.height);
  const hash = hashString(seed);
  const ox = covered.x + (hash % 1000) / 1000 * Math.max(0, covered.width - Math.max(width / scale, STEADY.width));
  const oy = covered.y + (Math.floor(hash / 1000) % 1000) / 1000 * Math.max(0, covered.height - Math.max(height / scale, STEADY.height));
  const hatPx = HAT_WIDTH * scale;
  const edge = (y: number) => WEDGE.at * width + (y - height / 2) * WEDGE.lean;
  // Where the light falls from: the upper right of a band, of a wedge the top of its edge.
  const lit = kind === 'wedge' ? edge(0) : width;

  // How dark a band's foot gets: a header band's full depth, less in a slim bar, whose title and
  // controls sit in its middle rather than on a foot of their own.
  const depth = .75 * Math.min(1, height / 160);
  const tiles: HatTile[] = [];

  for (const [index, hat] of tiling().entries()) {
    const corners = hat.corners.map(([x, y]) => [(x - ox) * scale, (y - oy) * scale] as const);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, sumX = 0, sumY = 0;
    for (const [x, y] of corners) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      sumX += x;
      sumY += y;
    }
    if (maxX <= 0 || minX >= width || maxY <= 0 || minY >= height) continue;
    const d = `M${corners.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L')}Z`;
    const x = sumX / corners.length;
    const y = sumY / corners.length;
    const jitter = unit(hash ^ 0x5bd1e995, index);
    if (kind === 'cover') {
      const under = backdrop ? luminanceAt(backdrop, width, height, x, y, hatPx / 2) : 0;
      tiles.push({ d, x, y, fill: 0, shade: 1, glint: false, jitter, onLight: round(smoothstep(...ON_LIGHT, under)), ground: 0 });
      continue;
    }
    // How many hats past a wedge's edge, give or take its scatter.
    const across = (x - edge(y)) / hatPx + (unit(hash ^ 0x27d4eb2f, index) - .5) * WEDGE.scatter;
    const ground = kind === 'wedge' ? round(1 - smoothstep(-WEDGE.fade, WEDGE.fade, across)) : 0;
    if (kind === 'wedge' && ground === 0) continue;

    const light = Math.max(0, 1 - Math.hypot((x - .86 * lit) / (.62 * lit), (y + .3 * height) / (1.5 * height)));
    const shade = (kind === 'band' || kind === 'wedge' ? 1 - depth * smoothstep(.1, 1, y / height) : 1) * (kind === 'wedge' ? ground : 1);
    tiles.push({
      d,
      x,
      y,
      fill: round((.09 + .05 * unit(hash, index) + .1 * light + (hat.mirrored ? .1 : 0)) * shade),
      shade: round(shade),
      glint: kind === 'band' ? x > .3 * width && y < .55 * height : kind === 'wedge' ? y < .45 * height && ground === 1 : kind !== 'foot',
      jitter,
      onLight: 0,
      ground,
    });
  }

  return { tiles, hatSize: hatPx };
}

/** A number in [0, 1) for hat `index` of the field seeded with `hash`. */
function unit(hash: number, index: number): number {
  let h = Math.imul(index ^ hash, 0x9e3779b1);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 2 ** 32;
}

function smoothstep(from: number, to: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

const round = (value: number): number => Math.round(value * 1000) / 1000;
