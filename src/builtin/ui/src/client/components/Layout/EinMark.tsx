import { useId } from 'react';
import { HAT_KITES, HAT_POINTS } from '../../lib/hat.ts';

/** The mark's colours in hue order, as the gradient crosses the hat: teal, cyan, blue, violet, pink, orange. */
export const MARK_COLORS = ['#38d9a9', '#22b8cf', '#339af0', '#da77f2', '#f06595', '#ffa94d'] as const;

const MARK_OFFSETS = [.04, .2, .36, .54, .7, .86];

/**
 * How light or dark each of `HAT_KITES` is drawn over the gradient, as a kite facing a light from
 * the upper left would be: white at that opacity, or the app's background where it is negative.
 */
const KITE_SHADE = [.24, .12, -.1, -.1, -.2, .21, .12, -.2];

/**
 * The mark's gradient, laid across a hat in `HAT_POINTS` units: from teal at its upper left to
 * orange at its foot.
 */
export function MarkGradient({ id }: { id: string }) {
  return (
    <linearGradient id={id} gradientUnits='userSpaceOnUse' x1='-1' y1='-1.9' x2='2.6' y2='2.6'>
      {MARK_COLORS.map((color, i) => <stop key={color} offset={MARK_OFFSETS[i]} stopColor={color} />)}
    </linearGradient>
  );
}

/** How one of `HAT_KITES` (by index) is shaded over the gradient, as a facet. */
export function kiteShade(index: number) {
  const shade = KITE_SHADE[index];
  return { fill: shade > 0 ? '#fff' : '#101217', fillOpacity: Math.abs(shade) };
}

/**
 * EiN's mark: one einstein hat, the tile the headers' background is laid with, cut into its eight
 * kites like cut glass, in the mark's colours. `root/favicon.svg` draws the same mark; keep the two
 * in step.
 */
export function EinMark({ size = 22 }: { size?: number }) {
  // Two marks on one page must not share a gradient id; useId's colons are not
  // valid in a url() reference, so they are dropped.
  const gradient = `mrx-mark-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;

  return (
    <svg width={size} height={size} viewBox='-2 -2.567 7 7' aria-hidden focusable='false' style={{ display: 'block', flex: 'none' }}>
      <defs>
        <MarkGradient id={gradient} />
      </defs>
      <polygon points={HAT_POINTS} fill={`url(#${gradient})`} />
      {HAT_KITES.map((points, i) => <polygon key={points} points={points} {...kiteShade(i)} />)}
      <g fill='none' stroke='#fff' strokeLinejoin='round'>
        {HAT_KITES.map((points) => <polygon key={points} points={points} strokeOpacity={0.38} strokeWidth={0.06} />)}
        <polygon points={HAT_POINTS} strokeOpacity={0.35} strokeWidth={0.16} />
      </g>
    </svg>
  );
}
