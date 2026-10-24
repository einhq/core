import { fullscreenRouteFromSearch, withFullscreenSearch } from './fullscreen-search.ts';

/**
 * The lightbox is the route of one media file, `/media/<path, URI-encoded>` as an album is
 * `/albums/<path>`. Opened from a grid it is shown full screen over the page, which keeps it
 * in its `fullscreen` parameter; opened by its URL it is the page.
 */
const LIGHTBOX_ROUTE = '/media/';

/** The lightbox's route for a media path. */
export function lightboxRoute(path: string): string {
  return `${LIGHTBOX_ROUTE}${encodeURIComponent(path)}`;
}

/** The media path a route shows in the lightbox, or undefined when it is another route. */
export function lightboxPathFromRoute(route: string | null | undefined): string | undefined {
  if (!route?.startsWith(LIGHTBOX_ROUTE)) return undefined;
  const id = route.slice(LIGHTBOX_ROUTE.length).split(/[?#]/)[0];
  if (!id || id.includes('/')) return undefined;
  try {
    return decodeURIComponent(id);
  } catch {
    return undefined;
  }
}

/** The media path open full screen over a page, from its query string. */
export function lightboxPathFromSearch(search: string): string | undefined {
  return lightboxPathFromRoute(fullscreenRouteFromSearch(search));
}

/** A page's query string with the lightbox open over it, the page's own parameters kept. */
export function withLightboxSearch(search: string, path: string): string {
  return withFullscreenSearch(search, lightboxRoute(path));
}
