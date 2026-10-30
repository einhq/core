import { assertEquals } from '@std/assert';
import { detectIndent, TextBuffer } from '../buffer.ts';

Deno.test('TextBuffer', async (t) => {
  await t.step('a multi-line paste splits the line around it', () => {
    const buffer = new TextBuffer('start end');
    buffer.moveTo({ line: 0, col: 6 });
    buffer.paste('a\nb\nc ');
    assertEquals(buffer.lines, ['start a', 'b', 'c end']);
    assertEquals(buffer.cursor, { line: 2, col: 2 });
  });

  await t.step('a paste can have more lines than a call takes arguments', () => {
    const buffer = new TextBuffer('ab');
    buffer.moveTo({ line: 0, col: 1 });
    buffer.paste('x\n'.repeat(300_000));
    assertEquals(buffer.lines.length, 300_001);
    assertEquals(buffer.lines[300_000], 'b');
  });

  await t.step('backspace at a line start and delete at a line end join lines', () => {
    const buffer = new TextBuffer('ab\ncd');
    buffer.moveTo({ line: 1, col: 0 });
    buffer.backspace();
    assertEquals(buffer.lines, ['abcd']);
    assertEquals(buffer.cursor, { line: 0, col: 2 });
    buffer.newline();
    assertEquals(buffer.lines, ['ab', 'cd']);
    buffer.moveTo({ line: 0, col: 2 });
    buffer.deleteForward();
    assertEquals(buffer.lines, ['abcd']);
  });

  await t.step('Enter keeps the indent, and leaves a line holding only indent empty', () => {
    const buffer = new TextBuffer('  key: value');
    buffer.end();
    buffer.newline();
    assertEquals(buffer.lines, ['  key: value', '  ']);
    assertEquals(buffer.cursor, { line: 1, col: 2 });
    buffer.newline();
    assertEquals(buffer.lines, ['  key: value', '', '  ']);
  });

  await t.step('the indent unit follows the text', () => {
    assertEquals(detectIndent(['a:', '    b: 1', '        c: 2']), '    ');
    assertEquals(detectIndent(['a', '\tb', '\tc', '  d']), '\t');
    assertEquals(detectIndent(['plain']), '  ');
    assertEquals(detectIndent(['all:', '    x'], true), '\t');
  });

  await t.step('Tab follows the indent the text has now, not the one it opened with', () => {
    const buffer = new TextBuffer('notes');
    buffer.end();
    buffer.paste('\nif x:\n    y');
    buffer.newline();
    buffer.indent();
    assertEquals(buffer.lines[3], '        ');
  });

  await t.step('cut takes the whole line', () => {
    const buffer = new TextBuffer('one\ntwo\nthree');
    buffer.moveTo({ line: 1, col: 1 });
    assertEquals(buffer.cutLine(), 'two\n');
    assertEquals(buffer.lines, ['one', 'three']);
    assertEquals(buffer.cursor, { line: 1, col: 0 });
  });

  await t.step('a typed word undoes as one, and undo brings the version back', () => {
    const buffer = new TextBuffer('');
    const start = buffer.version;
    buffer.type('a');
    buffer.type('b');
    buffer.type(' ');
    buffer.type('c');
    assertEquals(buffer.text, 'ab c');
    buffer.undo();
    assertEquals(buffer.text, 'ab ');
    buffer.undo();
    assertEquals(buffer.text, 'ab');
    buffer.undo();
    assertEquals(buffer.text, '');
    assertEquals(buffer.version, start);
    buffer.redo();
    assertEquals(buffer.text, 'ab');
  });

  await t.step('a pause ends a run of typing', () => {
    let now = 0;
    const buffer = new TextBuffer('', { now: () => now });
    buffer.type('a');
    now = 400;
    buffer.type('b');
    now = 1000;
    buffer.type('c');
    buffer.undo();
    assertEquals(buffer.text, 'ab');
    buffer.undo();
    assertEquals(buffer.text, '');
  });

  await t.step('a cursor move ends a run of typing', () => {
    const buffer = new TextBuffer('');
    buffer.type('a');
    buffer.left();
    buffer.type('b');
    buffer.undo();
    assertEquals(buffer.text, 'a');
  });

  await t.step('word moves skip punctuation and cross line ends', () => {
    const buffer = new TextBuffer('foo.bar baz\nnext');
    buffer.wordRight();
    assertEquals(buffer.cursor, { line: 0, col: 3 });
    buffer.wordRight();
    assertEquals(buffer.cursor, { line: 0, col: 7 });
    buffer.end();
    buffer.wordRight();
    assertEquals(buffer.cursor, { line: 1, col: 4 });
    buffer.moveTo({ line: 1, col: 0 });
    buffer.wordLeft();
    assertEquals(buffer.cursor, { line: 0, col: 8 });
  });

  await t.step('Home goes to the first non-blank, then to the line start', () => {
    const buffer = new TextBuffer('    x');
    buffer.end();
    buffer.home();
    assertEquals(buffer.cursor.col, 4);
    buffer.home();
    assertEquals(buffer.cursor.col, 0);
  });

  await t.step('a surrogate pair is one character to move over and delete', () => {
    const buffer = new TextBuffer('😀x');
    buffer.right();
    assertEquals(buffer.cursor.col, 2);
    buffer.backspace();
    assertEquals(buffer.text, 'x');
    buffer.moveTo({ line: 0, col: 0 });
    buffer.paste('😀');
    buffer.moveTo({ line: 0, col: 1 });
    assertEquals(buffer.cursor.col, 0);
  });

  await t.step('find ignores case and wraps past the end', () => {
    const buffer = new TextBuffer('Alpha\nbeta\nalpha');
    buffer.moveTo({ line: 2, col: 0 });
    assertEquals(buffer.find('ALPHA'), { pos: { line: 0, col: 0 }, wrapped: true });
    buffer.moveTo({ line: 0, col: 0 });
    assertEquals(buffer.find('alpha'), { pos: { line: 2, col: 0 }, wrapped: false });
    assertEquals(buffer.find('gamma'), undefined);
  });
});
