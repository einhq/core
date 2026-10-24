import { assertEquals } from '@std/assert';
import { expiryText, isShareLinkPage, openedText, shareLinkUrl, withinRoute } from '../share-link.ts';

const album = `/albums/${encodeURIComponent('/archive/albums/Sommar')}`;

Deno.test('share link: a visitor sees the album a link opens and the folders inside it', () => {
  assertEquals(withinRoute(album, album), true);
  assertEquals(withinRoute(`/albums/${encodeURIComponent('/archive/albums/Sommar/dag 2')}`, album), true);
  // The browser may hand the path over decoded.
  assertEquals(withinRoute('/albums//archive/albums/Sommar/dag 2', album), true);
});

Deno.test('share link: nothing beside the album, nor an album whose name only starts the same', () => {
  assertEquals(withinRoute(`/albums/${encodeURIComponent('/archive/albums/Sommarstuga')}`, album), false);
  assertEquals(withinRoute('/people/Anna_Andersson', album), false);
  assertEquals(withinRoute('/', album), false);
});

Deno.test('share link: the opening page and the address it is sent as', () => {
  assertEquals(shareLinkUrl('https://ein.example', 'AbC123'), 'https://ein.example/s/AbC123');
  assertEquals(isShareLinkPage('/s/AbC123'), true);
  assertEquals(isShareLinkPage('/s/'), false);
  assertEquals(isShareLinkPage('/search'), false);
});

const NOW = Date.UTC(2026, 9, 12, 12);
const DAY = 24 * 60 * 60 * 1000;

Deno.test('share link: when it stops working, in words', () => {
  assertEquals(expiryText(undefined, NOW), 'Never expires');
  assertEquals(expiryText(NOW - 1, NOW), 'Expired');
  assertEquals(expiryText(NOW + 3 * 60 * 60 * 1000, NOW), 'Expires within a day');
  assertEquals(expiryText(NOW + 30 * DAY, NOW).startsWith('Expires in 30 days, on '), true);
});

Deno.test('share link: how often it was opened, and when last', () => {
  assertEquals(openedText(0, undefined, NOW), 'Not opened yet');
  assertEquals(openedText(1, NOW - 60_000, NOW), 'Opened once, last today');
  assertEquals(openedText(4, NOW - DAY, NOW), 'Opened 4 times, last yesterday');
  assertEquals(openedText(4, NOW - 3 * DAY, NOW), 'Opened 4 times, last 3 days ago');
  assertEquals(openedText(9, NOW - 20 * DAY, NOW).startsWith('Opened 9 times, last on '), true);
});
