import { assertEquals, assertThrows } from '@std/assert';
import { chmodToMode, getModeString } from '../mode.ts';

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

Deno.test("t is the sticky bit, in the others' class", () => {
  assertEquals(chmodToMode('+t', 0o777), 0o1777);
  assertEquals(chmodToMode('o+t', 0o777), 0o1777);
  assertEquals(chmodToMode('u+t', 0o777), 0o777);
  assertEquals(chmodToMode('-t', 0o1777), 0o777);
  assertEquals(chmodToMode('o=rx', 0o1777), 0o775);
  assertEquals(chmodToMode('1777'), 0o1777);
});

Deno.test("the sticky bit shows in the others' execute position", () => {
  assertEquals(getModeString(0o1777), 'rwxrwxrwt');
  assertEquals(getModeString(0o1776), 'rwxrwxrwT');
  assertEquals(getModeString(0o755), 'rwxr-xr-x');
});

Deno.test('a clause that is not a mode is refused', () => {
  assertThrows(() => chmodToMode('o=q', 0o755), Error, 'invalid mode clause');
  assertThrows(() => chmodToMode('rwx', 0o755), Error, 'invalid mode clause');
});
