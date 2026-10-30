import { assertEquals, assertThrows } from '@std/assert';
import { chmodToMode } from '../mode.ts';

Deno.test("a symbolic mode adds, removes and sets a class's bits", () => {
  assertEquals(chmodToMode('g+w', 0o750), 0o770);
  assertEquals(chmodToMode('o-rx', 0o755), 0o750);
  assertEquals(chmodToMode('u=rwx,g=rx,o=', 0o777), 0o750);
});

Deno.test('an empty = clears the class, as coreutils chmod does', () => {
  assertEquals(chmodToMode('o=', 0o755), 0o750);
  assertEquals(chmodToMode('go=', 0o775), 0o700);
  assertEquals(chmodToMode('g+', 0o750), 0o750);
});

Deno.test('a clause that is not a mode is refused', () => {
  assertThrows(() => chmodToMode('o=q', 0o755), Error, 'invalid mode clause');
  assertThrows(() => chmodToMode('rwx', 0o755), Error, 'invalid mode clause');
});
