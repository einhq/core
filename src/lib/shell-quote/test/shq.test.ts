import { assertEquals } from '@std/assert';
import { shq } from '../mod.ts';

Deno.test('shq', async (t) => {
  await t.step('wraps a plain value in single quotes', () => {
    assertEquals(shq(`/archive/albums/photo.jpg`), `'/archive/albums/photo.jpg'`);
  });

  await t.step('keeps spaces inside one quoted word', () => {
    assertEquals(shq(`/archive/albums/Alexandra Gustafsson.mp3`), `'/archive/albums/Alexandra Gustafsson.mp3'`);
  });

  await t.step('escapes embedded single quotes with the POSIX idiom', () => {
    assertEquals(shq("a b'c"), `'a b'\\''c'`);
    assertEquals(shq("it's"), `'it'\\''s'`);
  });

  await t.step('leaves shell metacharacters literal', () => {
    assertEquals(shq('na"me $x `id` *.jpg'), `'na"me $x \`id\` *.jpg'`);
  });

  await t.step('handles an empty string', () => {
    assertEquals(shq(''), `''`);
  });
});
