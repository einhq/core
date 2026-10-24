import type { HatTile } from './hat-field.ts';

/** The ways a hat field can arrive, as the setting lists them. */
export const HAT_ENTRANCES = ['drawn', 'falling', 'sliding', 'sweep', 'growing', 'ripple', 'puzzle', 'wave'] as const;

export type HatEntrance = typeof HAT_ENTRANCES[number];

export const isHatEntrance = (value: unknown): value is HatEntrance => HAT_ENTRANCES.includes(value as HatEntrance);

/** How one tile arrives: CSS for its path, and for `wave` a flash drawn over it. */
type TileEntrance = {
  style: Record<string, string>;
  /** Set on the path while it is drawn, so that a dash of 1 is its whole outline. */
  pathLength?: number;
  flash?: Record<string, string>;
};

/**
 * Each tile's entrance (`HAT_ENTRANCES`), in `tiles`' order, and when the last one has ended, in ms:
 * `duration`, since the timings written below are scaled so the last tile ends then. Every animation ends on the tile as the field draws it at rest and holds there (`both`), so taking
 * the styles off afterwards changes nothing on screen. A ripple starts at `origin`.
 *
 * - `drawn`: each outline is drawn as if by pen and its colour floods in behind, the foot first.
 * - `falling`: tiles drop in from above and land with a small bounce, the foot first.
 * - `sliding`: tiles glide in from past the right edge and settle, the left first.
 * - `sweep`: tiles fade in one after another from left to right.
 * - `growing`: rows rise from the foot, each tile unfolding upwards from its base.
 * - `ripple`: tiles pop in outwards from `origin`.
 * - `puzzle`: tiles twist and shrink into their places in random order.
 * - `wave`: the field fades in at once, then one bright wave runs across it.
 */
export function hatEntrance(
  entrance: HatEntrance,
  duration: number,
  tiles: HatTile[],
  width: number,
  height: number,
  hatSize: number,
  origin: readonly [number, number],
): { tiles: TileEntrance[]; ends: number } {
  // Laid out at the written pace to learn how long that takes, then at the pace that takes `duration`.
  const written = writtenEntrance(entrance, tiles, width, height, hatSize, origin, 1).ends;
  return { tiles: writtenEntrance(entrance, tiles, width, height, hatSize, origin, duration / written).tiles, ends: duration };
}

/** `hatEntrance` with the timings written below run at `pace`: 1 as written, .5 twice as fast. */
function writtenEntrance(
  entrance: HatEntrance,
  tiles: HatTile[],
  width: number,
  height: number,
  hatSize: number,
  origin: readonly [number, number],
  pace: number,
): { tiles: TileEntrance[]; ends: number } {
  // From the foot: 0 there, 1 at the top.
  const rise = (tile: HatTile) => 1 - tile.y / height;
  const reach = Math.max(...[[0, 0], [width, 0], [0, height], [width, height]].map(([x, y]) => Math.hypot(x - origin[0], y - origin[1])));
  let ends = 0;

  const animate = (...parts: [name: string, ms: number, delay: number, easing: string][]) => {
    for (const [, ms, delay] of parts) ends = Math.max(ends, (ms + delay) * pace);
    return parts.map(([name, ms, delay, easing]) => `mrx-hat-${name} ${Math.round(ms * pace)}ms ${easing} ${Math.round(delay * pace)}ms both`).join(', ');
  };

  const entering = tiles.map((tile): TileEntrance => {
    switch (entrance) {
      case 'drawn': {
        const delay = rise(tile) * 820 + tile.jitter * 160;
        return {
          style: {
            animation: animate(['draw', 520, delay, 'ease-out'], ['fill-in', 420, delay + 380, 'ease-out']),
            strokeDasharray: '1',
            '--mrx-hat-fill': String(tile.fill),
          },
          pathLength: 1,
        };
      }
      case 'falling':
        return {
          style: {
            animation: animate(['fall', 640, rise(tile) * 520 + (tile.x / width) * 260 + tile.jitter * 160, 'cubic-bezier(.3,1.35,.55,1)']),
            '--mrx-hat-drop': `${-Math.round(tile.y + hatSize * 1.2)}px`,
          },
        };
      case 'sliding':
        return {
          style: {
            animation: animate(['slide', 640, (tile.x / width) * 520 + (tile.y / height) * 260 + tile.jitter * 160, 'cubic-bezier(.22,1,.36,1)']),
            '--mrx-hat-slide': `${Math.round(width - tile.x + hatSize * 1.2)}px`,
          },
        };
      case 'sweep':
        return { style: { animation: animate(['fade', 280, (tile.x / width) * 1250, 'ease-out']) } };
      case 'growing':
        return { style: { animation: animate(['grow', 420, rise(tile) * 720 + tile.jitter * 120, 'cubic-bezier(.2,.9,.3,1.1)']), transformOrigin: '50% 100%' } };
      case 'ripple': {
        const delay = Math.hypot(tile.x - origin[0], tile.y - origin[1]) / reach * 950;
        return { style: { animation: animate(['pop', 460, delay, 'cubic-bezier(.2,.9,.3,1.2)']) } };
      }
      case 'puzzle':
        return { style: { animation: animate(['snap', 520, tile.jitter * 950, 'cubic-bezier(.2,1.25,.4,1)']) } };
      case 'wave':
        return {
          style: { animation: animate(['appear', 360, tile.jitter * 140, 'ease-out']) },
          flash: { animation: animate(['flash', 620, 380 + (tile.x / width) * 900 + (tile.y / height) * 140, 'ease-in-out']) },
        };
    }
  });
  return { tiles: entering, ends };
}
