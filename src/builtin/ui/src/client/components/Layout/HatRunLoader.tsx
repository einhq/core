import { Box } from '@mantine/core';
import { type HTMLAttributes, type Ref, useId } from 'react';
import { HAT_POINTS } from '../../lib/hat.ts';
import { MarkGradient } from './EinMark.tsx';

/**
 * What every Mantine `Loader` draws, a loading button's included (the theme's `hat` type): the
 * hat's outline, faint, with a third of it lit and running round. It is as tall as the loader's
 * size and as wide as the hat, so a slot sized for a spinner still shows the hat's shape. The lit
 * third takes the mark's colours, or the colour the loader is given: a filled button's white, a
 * status colour.
 */
export function HatRunLoader({ className, style, ref, ...others }: HTMLAttributes<HTMLSpanElement> & { ref?: Ref<HTMLSpanElement> }) {
  // Two loaders on one page must not share a gradient id; useId's colons are not valid in a
  // url() reference, so they are dropped.
  const gradient = `mrx-hat-run-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  // Mantine puts `--loader-color` on the loader only when it is given a colour.
  const tinted = (style as Record<string, unknown> | undefined)?.['--loader-color'] !== undefined;

  return (
    <Box component='span' ref={ref} className={className ? `mrx-hat-run ${className}` : 'mrx-hat-run'} style={style} {...others}>
      <svg viewBox='-1.8 -2.03 6.6 4.93' aria-hidden focusable='false'>
        {!tinted && (
          <defs>
            <MarkGradient id={gradient} />
          </defs>
        )}
        <polygon points={HAT_POINTS} data-track />
        <polygon points={HAT_POINTS} pathLength={1} stroke={tinted ? 'var(--loader-color)' : `url(#${gradient})`} data-run data-mrx-spinner />
      </svg>
    </Box>
  );
}
