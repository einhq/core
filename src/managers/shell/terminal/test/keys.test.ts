import { assertEquals } from '@std/assert';
import { KeyReader } from '../keys.ts';

const encoder = new TextEncoder();
const feed = (reader: KeyReader, text: string) => reader.feed(encoder.encode(text));

Deno.test('KeyReader', async (t) => {
  await t.step('typed characters come as one text event', () => {
    assertEquals(feed(new KeyReader(), 'héllo'), [{ type: 'text', text: 'héllo' }]);
  });

  await t.step('cursor keys in their CSI, SS3 and tilde forms, with modifiers', () => {
    const keys = feed(new KeyReader(), '\x1b[A\x1b[1;5C\x1b[1;2D\x1bOH\x1b[4~\x1b[3~\x1b[5~\x1b[6~\x1b[Z');
    assertEquals(keys, [
      { type: 'key', name: 'up' },
      { type: 'key', name: 'right', ctrl: true },
      { type: 'key', name: 'left', shift: true },
      { type: 'key', name: 'home' },
      { type: 'key', name: 'end' },
      { type: 'key', name: 'delete' },
      { type: 'key', name: 'pageup' },
      { type: 'key', name: 'pagedown' },
      { type: 'key', name: 'tab', shift: true },
    ]);
  });

  await t.step('control characters are named keys', () => {
    assertEquals(feed(new KeyReader(), '\x13\x11\r\n\t\x7f\x08'), [
      { type: 'key', name: 's', ctrl: true },
      { type: 'key', name: 'q', ctrl: true },
      { type: 'key', name: 'enter' },
      { type: 'key', name: 'tab' },
      { type: 'key', name: 'backspace' },
      { type: 'key', name: 'backspace' },
    ]);
  });

  await t.step('an escape sequence cut between chunks is finished by the next', () => {
    const reader = new KeyReader();
    assertEquals(feed(reader, 'a\x1b['), [{ type: 'text', text: 'a' }]);
    assertEquals(feed(reader, '1;5'), []);
    assertEquals(feed(reader, 'Db'), [{ type: 'key', name: 'left', ctrl: true }, { type: 'text', text: 'b' }]);
  });

  await t.step('a UTF-8 character cut between chunks comes whole', () => {
    const reader = new KeyReader();
    const bytes = encoder.encode('ä😀');
    assertEquals(reader.feed(bytes.slice(0, 1)), []);
    assertEquals(reader.feed(bytes.slice(1, 4)), [{ type: 'text', text: 'ä' }]);
    assertEquals(reader.feed(bytes.slice(4)), [{ type: 'text', text: '😀' }]);
  });

  await t.step('a bracketed paste is one event, across chunks, with its line ends as \\n', () => {
    const reader = new KeyReader();
    assertEquals(feed(reader, '\x1b[200~ab'), []);
    assertEquals(feed(reader, 'c\r\nd\x1b[20'), []);
    assertEquals(feed(reader, '1~x'), [{ type: 'paste', text: 'abc\nd' }, { type: 'text', text: 'x' }]);
  });

  await t.step('a lone ESC is the Escape key, ESC before a character is Alt', () => {
    assertEquals(feed(new KeyReader(), '\x1b'), [{ type: 'key', name: 'escape' }]);
    assertEquals(feed(new KeyReader(), '\x1bb'), [{ type: 'key', name: 'b', alt: true }]);
  });
});
