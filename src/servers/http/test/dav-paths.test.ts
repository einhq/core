/** WebDAV's addresses: `/dav/<path>` to the tree and back, and where a MOVE's Destination points. */

import { assertEquals } from '@std/assert';
import { davHref, davPath, destination, isDavPath } from '../dav/paths.ts';

Deno.test('/dav and what lies under it are WebDAV; /davx is not', () => {
  assertEquals(isDavPath('/dav'), true);
  assertEquals(isDavPath('/dav/home'), true);
  assertEquals(isDavPath('/davx'), false);
  assertEquals(isDavPath('/file/dav'), false);
});

Deno.test('a WebDAV path names the tree path with each segment decoded', () => {
  assertEquals(davPath('/dav'), '/');
  assertEquals(davPath('/dav/'), '/');
  assertEquals(davPath('/dav//home//anna/'), '/home/anna');
  assertEquals(davPath('/dav/archive/albums/Midsommar%20%232%3F'), '/archive/albums/Midsommar #2?');
  assertEquals(davPath('/dav/home/anna/bl%C3%A5b%C3%A4r%2B100%25.jpg'), '/home/anna/blåbär+100%.jpg');
});

Deno.test('a segment that decodes to a separator, NUL, a dot segment or nothing is refused', () => {
  assertEquals(davPath('/dav/home/anna%2F..%2Fadmin'), undefined);
  assertEquals(davPath('/dav/home/a%00b'), undefined);
  assertEquals(davPath('/dav/home/%2E%2E'), undefined);
  assertEquals(davPath('/dav/home/%E0%A4%A'), undefined);
  assertEquals(davPath('/file/home'), undefined);
});

Deno.test('an href encodes each segment, and a collection ends in a slash', () => {
  assertEquals(davHref('/', true), '/dav/');
  assertEquals(davHref('/home/anna', true), '/dav/home/anna/');
  assertEquals(davHref('/archive/albums/Midsommar #2?/a+b.jpg', false), '/dav/archive/albums/Midsommar%20%232%3F/a%2Bb.jpg');
  for (const path of ['/home/anna/blåbär 100%.jpg', '/a/#?&=+;,']) assertEquals(davPath(davHref(path, false)), path);
});

Deno.test('a Destination is read against the request, whatever its scheme and host, and must stay in /dav', () => {
  const url = new URL('http://127.0.0.1:8080/dav/home/anna/a.jpg.tacitpart');
  assertEquals(destination('https://ein.wrenfield.example/dav/home/anna/a.jpg', url), { path: '/home/anna/a.jpg' });
  assertEquals(destination('/dav/home/anna/b%20c.jpg', url), { path: '/home/anna/b c.jpg' });
  assertEquals(destination('/file/home/anna/a.jpg', url), { refused: 502 });
  assertEquals(destination('https://ein.wrenfield.example/dav/../etc/passwd', url), { refused: 502 });
  assertEquals(destination('/dav/home/a%2Fb', url), { refused: 400 });
  assertEquals(destination(null, url), { refused: 400 });
  assertEquals(destination('  ', url), { refused: 400 });
});
