import { assertEquals } from '@std/assert';
import { numberedName } from '../numbered-name.ts';

Deno.test('numberedName numbers before the extension', () => {
  assertEquals(numberedName('IMG_0042.jpg', 2), 'IMG_0042 (2).jpg');
  assertEquals(numberedName('clip.tar.gz', 3), 'clip.tar (3).gz');
});

Deno.test('numberedName treats a leading dot and no dot as no extension', () => {
  assertEquals(numberedName('.profile', 2), '.profile (2)');
  assertEquals(numberedName('README', 2), 'README (2)');
});
