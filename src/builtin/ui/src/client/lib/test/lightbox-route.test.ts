import { assertEquals } from '@std/assert';
import { fullscreenRouteFromSearch, withFullscreenSearch, withoutFullscreenSearch } from '../fullscreen-search.ts';
import { lightboxPathFromRoute, lightboxPathFromSearch, lightboxRoute, withLightboxSearch } from '../lightbox-route.ts';

Deno.test('lightbox route: a media path round-trips through its route, odd characters and all', () => {
  for (const path of [`/archive/albums/a/one.jpg`, `/archive/albums/Trip 2019/files/a#1 & b?.jpg`, '/files/100%.png']) {
    const route = lightboxRoute(path);
    assertEquals(route.split('/').length, 3, route);
    assertEquals(lightboxPathFromRoute(route), path);
  }
});

Deno.test('lightbox route: another route is not the lightbox', () => {
  assertEquals(lightboxPathFromRoute('/media'), undefined);
  assertEquals(lightboxPathFromRoute('/media/'), undefined);
  assertEquals(lightboxPathFromRoute('/media/a/b'), undefined);
  assertEquals(lightboxPathFromRoute('/albums/%2Fa'), undefined);
  assertEquals(lightboxPathFromRoute(null), undefined);
});

Deno.test('lightbox URL adds and replaces one path without losing other query parameters', () => {
  const opened = withLightboxSearch('?sort=date&direction=asc', `/archive/albums/a/one.jpg`);
  assertEquals(lightboxPathFromSearch(opened), `/archive/albums/a/one.jpg`);

  const switched = withLightboxSearch(opened, `/archive/albums/a/two.jpg`);
  assertEquals(new URLSearchParams(switched), new URLSearchParams({ sort: 'date', direction: 'asc', fullscreen: lightboxRoute(`/archive/albums/a/two.jpg`) }));
});

Deno.test('fullscreen URL removal retains unrelated query parameters', () => {
  const search = withFullscreenSearch('?sort=date', '/media/x');
  assertEquals(fullscreenRouteFromSearch(search), '/media/x');
  assertEquals(withoutFullscreenSearch(search), '?sort=date');
  assertEquals(withoutFullscreenSearch('?fullscreen=%2Fx'), '');
  assertEquals(fullscreenRouteFromSearch(withoutFullscreenSearch(search)), undefined);
});

Deno.test('fullscreen URL ignores a missing or blank route', () => {
  assertEquals(fullscreenRouteFromSearch(''), undefined);
  assertEquals(fullscreenRouteFromSearch('?fullscreen='), undefined);
  assertEquals(lightboxPathFromSearch('?fullscreen=%2Fchat'), undefined);
});
