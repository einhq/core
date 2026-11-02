import { signal } from '@preact/signals-react';

/**
 * The height in pixels of the row a page header keeps stuck under the app header
 * (`HeaderFilterBar`); 0 on a page without one. `useHeaderHeight` adds it to the app header's.
 */
export const stuckHeaderHeight = signal(0);

/**
 * How much of that page header goes under the app header before only its stuck row is left, in
 * pixels: the page scrolls this far to have the header stuck. 0 on a page without one.
 */
export const stuckHeaderAbove = signal(0);
