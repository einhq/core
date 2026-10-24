import { assertEquals } from '@std/assert';
import { countOf } from '../count-of.ts';

Deno.test('the noun agrees with the count', () => {
  assertEquals(countOf(1, 'album', 'albums'), '1 album');
  assertEquals(countOf(0, 'album', 'albums'), '0 albums');
  assertEquals(countOf(250_000, 'face', 'faces'), '250k faces');
});
