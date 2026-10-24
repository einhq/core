/**
 * The page's query parameter that holds the route open in the shell's full-screen surface
 * (`signals/surface.ts`): `/albums/x?fullscreen=%2Fmedia%2F…` is the album with a picture open
 * over it. In the URL rather than only in memory, so a reload or a shared link opens it again
 * and Back closes it — a phone's back gesture above all. Pure, so it round-trips in a test.
 */
const FULLSCREEN_PARAM = 'fullscreen';

/** The route the page's query string opens full screen, without accepting a blank one. */
export function fullscreenRouteFromSearch(search: string): string | undefined {
  return new URLSearchParams(search).get(FULLSCREEN_PARAM) || undefined;
}

/** Add or replace the full-screen route, leaving the page's own query parameters alone. */
export function withFullscreenSearch(search: string, route: string): string {
  const params = new URLSearchParams(search);
  params.set(FULLSCREEN_PARAM, route);
  return `?${params.toString()}`;
}

/** Remove only the full-screen route, keeping filters and other page state in the URL. */
export function withoutFullscreenSearch(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(FULLSCREEN_PARAM);
  const next = params.toString();
  return next ? `?${next}` : '';
}
