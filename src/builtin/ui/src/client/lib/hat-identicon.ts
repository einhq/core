import { hashString } from './hash-string.ts';
import { HAT_CLUSTER, HAT_POINTS } from './hat.ts';

/** How a hat identicon is drawn for one seed: the cluster turned and maybe mirrored, one hat lit, and the initials. */
type HatIdenticonSpec = {
  /** Degrees, a multiple of 60: the hat tiling's own symmetry, so every turn still looks like the pattern. */
  rotation: number;
  mirror: boolean;
  /** The SVG transform that turns and mirrors the cluster. */
  transform: string;
  /** The box the turned cluster fills, so no turn leaves part of it outside the picture. */
  viewBox: string;
  /** Which of the cluster's four hats is filled. */
  lit: number;
  initials: string;
};

type Point = [number, number];

const HAT: Point[] = HAT_POINTS.split(' ').map((pair) => pair.split(',').map(Number) as Point);
const CLUSTER = HAT_CLUSTER.map((matrix) => matrix.slice('matrix('.length, -1).split(' ').map(Number));

/** The cluster's middle, which a turn goes round and a mirror crosses. */
const CENTRE: Point = [2.1, 2.4];

/** Room round the outline for its stroke. */
const PAD = 0.1;

const round = (value: number) => Math.round(value * 1000) / 1000;

/** The turned, mirrored cluster's bounding box, as a `viewBox`. */
function fittedViewBox(rotation: number, mirror: boolean): string {
  const angle = (rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [a, b, c, d, e, f] of CLUSTER) {
    for (const [x, y] of HAT) {
      const placedX = a * x + c * y + e;
      const dx = (mirror ? 2 * CENTRE[0] - placedX : placedX) - CENTRE[0];
      const dy = b * x + d * y + f - CENTRE[1];
      const turnedX = CENTRE[0] + dx * cos - dy * sin;
      const turnedY = CENTRE[1] + dx * sin + dy * cos;
      minX = Math.min(minX, turnedX);
      maxX = Math.max(maxX, turnedX);
      minY = Math.min(minY, turnedY);
      maxY = Math.max(maxY, turnedY);
    }
  }
  return [minX - PAD, minY - PAD, maxX - minX + 2 * PAD, maxY - minY + 2 * PAD].map(round).join(' ');
}

/** Up to two letters for a name: the first of its first and last words, skipping what is not a letter (`? Berg` is `B`). */
export function initialsOf(name: string): string {
  const words = name.split(/[\s_-]+/).map((word) => word.replace(/^[^\p{L}\p{N}]+/u, '')).filter(Boolean);
  if (words.length === 0) return '';
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : '';
  return (first + last).toLocaleUpperCase();
}

/** The identicon for `seed` (a node's name or path): the same seed always draws the same one. */
export function hatIdenticon(seed: string, label = seed): HatIdenticonSpec {
  const hash = hashString(seed);
  const rotation = (hash % 6) * 60;
  const mirror = ((hash >>> 3) & 1) === 1;
  return {
    rotation,
    mirror,
    // Mirrored across the middle first, then turned round it.
    transform: `rotate(${rotation} ${CENTRE[0]} ${CENTRE[1]})${mirror ? ` translate(${2 * CENTRE[0]} 0) scale(-1 1)` : ''}`,
    viewBox: fittedViewBox(rotation, mirror),
    lit: (hash >>> 4) % 4,
    initials: initialsOf(label),
  };
}
