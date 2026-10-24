import { Box } from '@mantine/core';
import { HAT_CLUSTER, HAT_POINTS } from '../../lib/hat.ts';
import { hatIdenticon } from '../../lib/hat-identicon.ts';

type HatIdenticonProps = {
  /** What makes it this one's: a node's path or name. */
  seed: string;
  /** Whose initials it carries; the seed when absent. */
  label?: string;
  /** The hats' colour; the text colour around it when absent. */
  color?: string;
};

/**
 * A picture for something with no cover: four hats of the headers' pattern, turned and mirrored as
 * the seed says, one of them filled, with the initials over them. It fills the box it is put in.
 */
export function HatIdenticon({ seed, label, color = 'currentColor' }: HatIdenticonProps) {
  const spec = hatIdenticon(seed, label ?? seed);

  return (
    <Box className='mrx-hat-identicon' style={{ color }}>
      <svg viewBox={spec.viewBox} preserveAspectRatio='xMidYMid meet' aria-hidden focusable='false'>
        <g transform={spec.transform}>
          {HAT_CLUSTER.map((transform, index) => <polygon key={transform} points={HAT_POINTS} transform={transform} data-lit={index === spec.lit || undefined} />)}
        </g>
      </svg>
      {spec.initials && <span className='mrx-hat-identicon-initials'>{spec.initials}</span>}
    </Box>
  );
}
