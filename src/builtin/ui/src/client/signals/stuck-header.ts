import { signal } from '@preact/signals-react';

/**
 * The height in pixels of the row a page header keeps stuck under the app header
 * (`HeaderFilterBar`); 0 on a page without one. `useHeaderHeight` adds it to the app header's.
 */
export const stuckHeaderHeight = signal(0);
