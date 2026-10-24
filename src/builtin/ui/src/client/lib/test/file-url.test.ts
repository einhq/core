import { assertEquals } from '@std/assert';
import { encodeVfsPath, fileUrl } from '../file-url.ts';
import { displayUrl, gridSrcSet, imageSrcSet, thumbnailUrl } from '../derivatives.ts';

Deno.test('file url: an ordinary path is unchanged apart from its non-ASCII', () => {
  assertEquals(fileUrl(`/archive/albums/Jul/files/a.jpg`), `/file/archive/albums/Jul/files/a.jpg`);
  assertEquals(fileUrl(`/archive/albums/Höst/files/a.jpg`), `/file/archive/albums/H%C3%B6st/files/a.jpg`);
});

Deno.test('file url: URL-reserved characters in a node name are escaped, separators are not', () => {
  // Unescaped, `?` would start the query string and the server would see a truncated path.
  assertEquals(
    fileUrl(`/archive/albums/Fest2, Ö-resa och kopior?/files/x.jpg`),
    `/file/archive/albums/Fest2%2C%20%C3%96-resa%20och%20kopior%3F/files/x.jpg`,
  );
  assertEquals(encodeVfsPath('/a/b#c/d&e/f%g/h+i'), '/a/b%23c/d%26e/f%25g/h%2Bi');
  assertEquals(encodeVfsPath('/a/b/c').split('/').length, 4);
});

Deno.test('file url: decodes back to the path the server must resolve', () => {
  const paths = [
    `/archive/albums/Fest2, Ö-resa och kopior?/files/x.jpg`,
    `/archive/albums/50%/files/a b.jpg`,
    `/archive/albums/Anna & Erik's/files/#1.jpg`,
  ];

  for (const path of paths) {
    // What the handler does: decodeURIComponent over everything after `/file`.
    assertEquals(decodeURIComponent(fileUrl(path).slice('/file'.length)), path);
  }
});

Deno.test('file url: every derivative URL goes through the same encoding', () => {
  const path = `/archive/albums/what?/files/a.jpg`;

  assertEquals(thumbnailUrl(path, true), `/file/archive/albums/what%3F/files/a.jpg/thumbnails/320x320.avif`);
  assertEquals(displayUrl(path, 'photo', true), `/file/archive/albums/what%3F/files/a.jpg/thumbnails/1600x1600.avif`);
  // The no-derivatives fallback serves the original, and must be encoded too.
  assertEquals(thumbnailUrl(path, false), `/file/archive/albums/what%3F/files/a.jpg`);

  for (const srcset of [imageSrcSet(path, 'photo', true), gridSrcSet(path, true, 1.5)]) {
    assertEquals(srcset.includes('what?'), false, `unescaped "?" in srcset: ${srcset}`);
    assertEquals(srcset.includes('what%3F'), true);
  }
});
