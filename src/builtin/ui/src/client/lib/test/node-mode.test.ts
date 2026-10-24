import { assertEquals } from '@std/assert';
import { hasBit, modeOctal, modeString, parseOctal, withBit } from '../node-mode.ts';

Deno.test('node mode: string and octal renderings', () => {
  assertEquals(modeString(0o750), 'rwxr-x---');
  assertEquals(modeString(0o644), 'rw-r--r--');
  assertEquals(modeString(0), '---------');
  assertEquals(modeOctal(0o750), '0750');
  assertEquals(modeOctal(0o7777), '0777');
});

Deno.test('node mode: parseOctal accepts three or four octal digits only', () => {
  assertEquals(parseOctal('750'), 0o750);
  assertEquals(parseOctal('0644'), 0o644);
  assertEquals(parseOctal('758'), undefined);
  assertEquals(parseOctal('75'), undefined);
  assertEquals(parseOctal('rwx'), undefined);
});

Deno.test('node mode: bits can be read and toggled per class', () => {
  assertEquals(hasBit(0o750, 'owner', 'w'), true);
  assertEquals(hasBit(0o750, 'group', 'w'), false);
  assertEquals(withBit(0o750, 'other', 'r', true), 0o754);
  assertEquals(withBit(0o754, 'other', 'r', false), 0o750);
  assertEquals(withBit(0o750, 'owner', 'x', false), 0o650);
});
