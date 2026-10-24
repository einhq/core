import { assertEquals } from '@std/assert';
import { globToRegex } from '../glob.ts';

const matches = (pattern: string, text: string, pathname = false) => globToRegex(pattern, { pathname }).test(text);

Deno.test('glob: * crosses / by default', () => {
  assertEquals(matches('/home/*/staging/*', '/home/anna/notes/staging/x.pdf'), true);
  assertEquals(matches('image/*', 'image/jpeg'), true);
});

Deno.test('glob pathname: * ? and a negated class stop at /', () => {
  assertEquals(matches('/home/*/staging/*', '/home/anna/staging/x.pdf', true), true);
  assertEquals(matches('/home/*/staging/*', '/home/anna/notes/staging/x.pdf', true), false);
  assertEquals(matches('/home/*/staging/*', '/home/anna/staging/files/x.pdf', true), false);
  assertEquals(matches('/a?b', '/a/b', true), false);
  assertEquals(matches('/a[!x]b', '/a/b', true), false);
});

Deno.test('glob pathname: ** crosses /', () => {
  assertEquals(matches('/home/*/staging/**', '/home/anna/staging/files/x.pdf', true), true);
  assertEquals(matches('/home/*/staging/**', '/home/anna/notes/staging/x.pdf', true), false);
  assertEquals(matches('**/.**', '/home/anna/.trash/entry/x.pdf', true), true);
  assertEquals(matches('**/.**', '/home/anna/notes/x.pdf', true), false);
  assertEquals(matches('**/metadata/**', '/a/b/metadata/content', true), true);
  assertEquals(matches('**/metadata/**', '/a/b/metadata.txt', true), false);
  assertEquals(matches('/home/*/staging/**.gpx', '/home/anna/staging/files/walk.gpx', true), true);
});
