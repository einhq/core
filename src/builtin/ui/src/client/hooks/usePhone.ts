import { useMediaQuery } from '@mantine/hooks';

/** Below Mantine's `sm`: the app's phone layout. */
export const PHONE_QUERY = '(max-width: 47.99em)';

/**
 * Whether the window is phone-sized, for layout a stylesheet cannot switch by
 * itself — a Modal's `fullScreen`, the navbar's mode. Read on the first render
 * rather than after it, so a dialog does not open centred and then jump.
 */
export function usePhone(): boolean {
  return useMediaQuery(PHONE_QUERY, undefined, { getInitialValueInEffect: false }) ?? false;
}
