import { memo, useMemo } from 'react';
import { layoutHatField } from '../../lib/hat-field.ts';

/** How strongly the tiles are outlined: a texture, not a picture. */
const HAT_GROUND_OPACITY = 0.07;

/**
 * The ground behind a drawing dragged and zoomed in a box (the family tree, a module's canvas): the
 * hat tiling the page headers are cut from, outlined only and barely, so the box reads as a surface
 * without the tiles competing with what is drawn on it. It fills its positioned parent and stays put
 * while the drawing is dragged over it, so it is laid out once per box size, not once per frame;
 * `seed` picks where the tiling is cut.
 */
export const HatGround = memo(function HatGround({ width, height, seed }: { width: number; height: number; seed: string }) {
  const tiles = useMemo(() => (width > 0 && height > 0 ? layoutHatField(width, height, seed, 'backdrop').tiles : []), [width, height, seed]);
  return (
    <svg width={width} height={height} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} aria-hidden='true'>
      <g fill='none' stroke='var(--mantine-color-text)' strokeWidth={1} opacity={HAT_GROUND_OPACITY}>
        {tiles.map((tile, index) => <path key={index} d={tile.d} />)}
      </g>
    </svg>
  );
});
