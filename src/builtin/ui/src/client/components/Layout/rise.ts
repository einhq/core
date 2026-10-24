import type { MantineTransition } from '@mantine/core';

/**
 * How a control floating over the page's foot comes and goes: up from the bottom edge, fading in,
 * and back down the same way. Mantine's `Transition` takes it with `RISE_DURATION`.
 */
export const RISE: MantineTransition = {
  in: { opacity: 1, transform: 'translateY(0)' },
  out: { opacity: 0, transform: 'translateY(calc(100% + var(--mantine-spacing-md)))' },
  transitionProperty: 'transform, opacity',
};

/** `--mrx-dur-base` and `--mrx-ease`, which a `Transition` takes as numbers and names rather than tokens. */
export const RISE_DURATION = 180;
export const RISE_EASE = 'cubic-bezier(0.2, 0, 0, 1)';
