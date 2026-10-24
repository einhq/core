import { signal } from '@preact/signals-react';
import { drawerOfEntry, withDrawerEntry } from '../lib/drawer-entry.ts';
import { fullscreenRouteFromSearch, withFullscreenSearch, withoutFullscreenSearch } from '../lib/fullscreen-search.ts';
import { PHONE_QUERY } from '../hooks/usePhone.ts';
import { navigatePage, pageLocation } from './module-ui.ts';

/**
 * Where a route can be shown besides the page: the shell's dialog, over the page; its side
 * drawer, beside it; and full screen, over everything (the lightbox). A module gives routes;
 * its navigation entries say where to open one (`{ "dialog": "/devices/new" }`,
 * `{ "drawer": "/chat" }`, `{ "fullscreen": "/media/…" }`), and the same route is a page when
 * opened by its URL. Each surface renders its route with a router of its own over the same
 * route table (`components/Surface/`); a route asks where it is with `useSurface()`. A `panel`
 * is a route drawn inside another page, where a navigation entry of the `panels` kind puts it or
 * an answer names it (`RoutePanel`): the explorer's tool pane, a system tab, a stats section, an
 * entry of the home page's news.
 */
export type SurfaceKind = 'page' | 'dialog' | 'drawer' | 'fullscreen' | 'panel';

/** The route the dialog shows, null when closed. */
export const dialogPath = signal<string | null>(null);
/** The route the drawer shows, null when closed. */
export const drawerPath = signal<string | null>(null);

export const openDialog = (path: string): void => {
  dialogPath.value = path;
};
export const closeDialog = (): void => {
  dialogPath.value = null;
};

/**
 * Where the drawer covers the page (below `md`) it is a history entry, as full screen is: opening
 * it pushes the page's own location with the drawer's route in its state (`lib/drawer-entry.ts`),
 * so Back closes it rather than moving the page out of sight beneath it, and `DrawerHost` keeps
 * the drawer in step with the entry the page steps to. Beside the page it is no part of history.
 */
export const openDrawer = (path: string): void => {
  const opening = drawerPath.value === null;
  drawerPath.value = path;
  const location = pageLocation();
  if (!location || globalThis.matchMedia(DRAWER_BESIDE_QUERY).matches) return;
  const entered = drawerOfEntry(location.state) !== null;
  if (!opening && !entered) return;
  navigatePage(
    { pathname: location.pathname, search: location.search, hash: location.hash },
    { replace: entered, state: withDrawerEntry(location.state, path) },
  );
};

/** Close the drawer: Back from the entry its opening pushed, when the page is on it. */
export const closeDrawer = (): void => {
  drawerPath.value = null;
  const location = pageLocation();
  if (location && drawerOfEntry(location.state) !== null) navigatePage(-1);
};

/**
 * The route shown full screen, null when closed. Unlike the dialog's and the drawer's it lives
 * in the page's URL (`?fullscreen=`, `lib/fullscreen-search.ts`): opening it is a history entry,
 * so Back closes it, and a reload or a shared link opens it again. `FullscreenHost` keeps this
 * signal in step with the URL; a close sets it at once, before the URL has caught up.
 */
export const fullscreenPath = signal<string | null>(null);

/**
 * The drawer's width while it stays beside the full-screen route, null when it does not. The
 * drawer is the shell's aside, below the top bar, which full screen covers; on a desktop the
 * layout lifts it above full screen to the window's height instead, and full screen leaves it
 * this much room, so the chat stays in view beside the lightbox. On a phone, where the drawer
 * takes the whole width, full screen covers it.
 */
export const fullscreenBesideDrawer = signal<string | null>(null);

/** Where the drawer sits beside the page rather than over it: the aside's breakpoint, Mantine's `md`. */
export const DRAWER_BESIDE_QUERY = '(min-width: 62em)';

/** Marks the history entry an opening pushed, which a close can go back from. */
const PUSHED_KEY = 'fullscreenPushed';

const pushedByOpen = (state: unknown): boolean => !!state && typeof state === 'object' && (state as Record<string, unknown>)[PUSHED_KEY] === true;

/** Open a route full screen over the page, or show another one in its place when it is open. */
export const openFullscreen = (path: string): void => {
  const location = pageLocation();
  if (!location) return;
  const open = fullscreenRouteFromSearch(location.search) !== undefined;
  fullscreenPath.value = path;
  const to = { pathname: location.pathname, search: withFullscreenSearch(location.search, path), hash: location.hash };
  // The page's entry state goes along (the map's open cluster), so Back lands on the page as it was.
  const state = location.state && typeof location.state === 'object' ? location.state : {};
  navigatePage(to, open ? { replace: true, state: location.state } : { state: { ...state, [PUSHED_KEY]: true } });
};

/** Close the full-screen route: Back to the page it opened over, or, opened by a link, the page without it. */
export const closeFullscreen = (): void => {
  fullscreenPath.value = null;
  const location = pageLocation();
  if (!location || fullscreenRouteFromSearch(location.search) === undefined) return;
  if (pushedByOpen(location.state)) {
    navigatePage(-1);
    return;
  }
  navigatePage({ pathname: location.pathname, search: withoutFullscreenSearch(location.search), hash: location.hash }, { replace: true, state: location.state });
};

/**
 * Open a location as the page from the full-screen route, which it replaces in history: Back
 * from an album the lightbox linked to returns to the grid the lightbox was opened from.
 */
export const leaveFullscreen = (to: string): void => {
  fullscreenPath.value = null;
  navigatePage(to, { replace: true });
};

/** The first segment of a route, which the drawer keeps to: `/chat/42` → `/chat`. */
export const routeBase = (path: string): string => `/${path.split(/[/?#]/)[1] ?? ''}`;

/** Whether a path is a route base or below it. */
export const underBase = (pathname: string, base: string): boolean => pathname === base || pathname.startsWith(`${base}/`);

/** Whether the drawer shows this route (or another under its base, as a chat it moved to). */
export const drawerShows = (path: string): boolean => drawerPath.value !== null && routeBase(drawerPath.value) === routeBase(path);

/**
 * Open the route in the drawer, or close the drawer when it already shows it. On a phone, where
 * the drawer would take the whole screen, the route opens in the dialog instead, and closes it.
 */
export const toggleDrawer = (path: string): void => {
  if (globalThis.matchMedia(PHONE_QUERY).matches) {
    if (dialogPath.value !== null && routeBase(dialogPath.value) === routeBase(path)) closeDialog();
    else openDialog(path);
  } else if (drawerShows(path)) closeDrawer();
  else openDrawer(path);
};

// The width it was dragged to, kept for the next page load.
const DRAWER_WIDTH_KEY = 'ein-drawer-width';
export const DRAWER_MIN_WIDTH = 360;
export const DRAWER_DEFAULT_WIDTH = 460;
export const DRAWER_MAX_WIDTH = 960;

const clampWidth = (width: number) => Math.min(DRAWER_MAX_WIDTH, Math.max(DRAWER_MIN_WIDTH, Math.round(width)));

const storedWidth = (): number => {
  try {
    const stored = Number(localStorage.getItem(DRAWER_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? clampWidth(stored) : DRAWER_DEFAULT_WIDTH;
  } catch {
    return DRAWER_DEFAULT_WIDTH;
  }
};

/** The desktop width; below `md` the drawer takes the whole screen. */
export const drawerWidth = signal(storedWidth());
export const setDrawerWidth = (width: number): void => {
  drawerWidth.value = clampWidth(width);
  try {
    localStorage.setItem(DRAWER_WIDTH_KEY, String(drawerWidth.value));
  } catch {
    // not kept
  }
};
