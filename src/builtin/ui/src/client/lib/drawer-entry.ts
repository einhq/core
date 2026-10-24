/**
 * The page's history entry that holds the shell's side drawer where it covers the page
 * (`signals/surface.ts`): the page's own location, with the route the drawer shows in its
 * history state. In history rather than only in memory, so Back closes the drawer — a phone's
 * back gesture above all — instead of moving the page out of sight beneath it. Pure, so it
 * round-trips in a test.
 */
const DRAWER_STATE_KEY = 'drawer';

/** The drawer's route a history entry's state carries, null for an entry without the drawer. */
export function drawerOfEntry(state: unknown): string | null {
  const route = state && typeof state === 'object' ? (state as Record<string, unknown>)[DRAWER_STATE_KEY] : undefined;
  return typeof route === 'string' ? route : null;
}

/** An entry's state with the drawer's route added or replaced, keeping the page's own. */
export function withDrawerEntry(state: unknown, route: string): Record<string, unknown> {
  return { ...(state && typeof state === 'object' ? state : {}), [DRAWER_STATE_KEY]: route };
}
