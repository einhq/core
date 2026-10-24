import { assertEquals } from '@std/assert';
import { decodeText, encodeText } from '../mod.ts';
import { displayColumn, layoutLine, wrapSegments } from '../screen.ts';

const rowsOf = (line: string, width: number) => {
  const cells = layoutLine(line);
  return wrapSegments(cells, width).map(({ from, to }) => cells.slice(from, to).map((c) => c.text).join(''));
};

Deno.test('layout', async (t) => {
  await t.step('tabs reach the next stop and control characters show as ^X', () => {
    const cells = layoutLine('a\tb\x1b');
    assertEquals(cells.map((c) => c.text), ['a', '   ', 'b', '^[']);
    assertEquals(displayColumn(cells, 2), 4);
  });

  await t.step('wide characters take two columns', () => {
    const cells = layoutLine('日本x');
    assertEquals(displayColumn(cells, 2), 4);
  });

  await t.step('lines wrap at the last space that fits', () => {
    assertEquals(rowsOf('the quick brown fox', 10), ['the quick ', 'brown fox']);
  });

  await t.step('a word longer than the width is split', () => {
    assertEquals(rowsOf('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  });

  await t.step('wide characters count two columns when wrapping', () => {
    assertEquals(rowsOf('日本語の文', 4), ['日本', '語の', '文']);
  });

  await t.step('an empty line is one row', () => {
    assertEquals(wrapSegments([], 10), [{ from: 0, to: 0 }]);
  });
});

Deno.test('file text', async (t) => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

  await t.step('CRLF line ends and the final newline survive a round trip', () => {
    const file = decodeText(encode('a\r\nb\r\n'));
    assertEquals(file, { text: 'a\nb', crlf: true, finalNewline: true });
    assertEquals(decode(encodeText('a\nb\nc', file)), 'a\r\nb\r\nc\r\n');
  });

  await t.step('a file without a final newline is written without one', () => {
    const file = decodeText(encode('a\nb'));
    assertEquals(file.finalNewline, false);
    assertEquals(decode(encodeText(file.text, file)), 'a\nb');
  });

  await t.step('an emptied file stays empty', () => {
    assertEquals(decode(encodeText('', { crlf: false, finalNewline: true })), '');
  });
});
