import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { Editor } from '../editor.ts';
import { VirtualTerminal } from '../../../../../shell/terminal/test/virtual-terminal.ts';

const encoder = new TextEncoder();

const CTRL = (letter: string) => String.fromCharCode(letter.charCodeAt(0) - 96);
const DOWN = '\x1b[B';
const END = '\x1b[F';

/** An editor on a virtual terminal, with what it saved. */
async function open(
  text: string,
  opts: { lang?: string; language?: (firstLine: string) => string | undefined; rows?: number; cols?: number; now?: () => number } = {},
) {
  const rows = opts.rows ?? 10;
  const cols = opts.cols ?? 40;
  const terminal = new VirtualTerminal(rows, cols);
  const saves: string[] = [];
  const editor = new Editor({
    text,
    name: 'file',
    language: opts.language ?? (() => opts.lang),
    isNew: false,
    rows,
    cols,
    save: (saved) => {
      saves.push(saved);
      return Promise.resolve();
    },
    write: (data) => {
      terminal.write(data);
      return Promise.resolve();
    },
    now: opts.now,
  });
  await editor.start();
  const keys = (input: string) => editor.feed(encoder.encode(input));
  return { editor, terminal, saves, keys };
}

Deno.test('Editor', async (t) => {
  await t.step('typed text is saved with ^S', async () => {
    const { terminal, saves, keys } = await open('');
    await keys('hello\rworld');
    assertStringIncludes(terminal.text, '[Modified]');
    assertEquals(await keys(CTRL('s')), false);
    assertEquals(saves, ['hello\nworld']);
    assertStringIncludes(terminal.line(8), 'Saved');
  });

  await t.step('quitting unsaved asks first; n quits without saving', async () => {
    const { terminal, saves, keys } = await open('x');
    await keys('y');
    assertEquals(await keys(CTRL('q')), false);
    assertStringIncludes(terminal.line(9), 'Save changes?');
    assertEquals(await keys('n'), true);
    assertEquals(saves, []);
  });

  await t.step('y at the quit question saves and quits; Esc stays', async () => {
    const { saves, keys } = await open('x');
    await keys('y');
    await keys(CTRL('x'));
    assertEquals(await keys('\x1b'), false);
    await keys(CTRL('x'));
    assertEquals(await keys('y'), true);
    assertEquals(saves, ['yx']);
  });

  await t.step('Alt+B and Alt+F move a word, as in the shell', async () => {
    const { editor, keys } = await open('one two three');
    await keys(END);
    await keys('\x1bb\x1bb');
    assertEquals(editor.buffer.cursor, { line: 0, col: 4 });
    await keys('\x1bf');
    assertEquals(editor.buffer.cursor, { line: 0, col: 7 });
    assertEquals(editor.buffer.text, 'one two three');
  });

  await t.step('an unmodified buffer quits at once', async () => {
    const { keys } = await open('x');
    assertEquals(await keys(CTRL('q')), true);
  });

  await t.step('an error is marked in the gutter and the status bar', async () => {
    const { terminal } = await open('{\n  "a": [1, 2\n}', { lang: 'json', cols: 70 });
    assert(terminal.line(2).startsWith('✗'), terminal.line(2));
    assertStringIncludes(terminal.line(8), "✗ 3:1 expected ',' or ']'");
    assertStringIncludes(terminal.line(8), 'JSON ✗');
  });

  await t.step('saving over an error asks; n does not save, y does', async () => {
    const { terminal, saves, keys } = await open('{', { lang: 'json' });
    await keys(CTRL('s'));
    assertStringIncludes(terminal.line(9), 'Save with errors? (y/N)');
    await keys('n');
    assertEquals(saves, []);
    await keys(CTRL('s'));
    await keys('y');
    assertEquals(saves, ['{']);
  });

  await t.step('fixing the error clears it', async () => {
    const { terminal, keys } = await open('{"a": 1', { lang: 'json' });
    await keys(`${END}}`);
    assertStringIncludes(terminal.line(8), 'JSON ✓');
    assert(!terminal.text.includes('✗'));
  });

  await t.step('find moves to the next match; go-to moves to a line and column', async () => {
    const { editor, keys } = await open('one\ntwo\nthree two');
    await keys(`${CTRL('f')}two\r`);
    assertEquals(editor.buffer.cursor, { line: 1, col: 0 });
    await keys(`${CTRL('f')}\r`);
    assertEquals(editor.buffer.cursor, { line: 2, col: 6 });
    await keys(`${CTRL('g')}1:3\r`);
    assertEquals(editor.buffer.cursor, { line: 0, col: 2 });
  });

  await t.step('cut lines in a row paste back together', async () => {
    const { editor, keys } = await open('a\nb\nc');
    await keys(`${CTRL('k')}${CTRL('k')}${CTRL('u')}${CTRL('u')}`);
    assertEquals(editor.buffer.text, 'a\nb\na\nb\nc');
  });

  await t.step('undo and redo', async () => {
    const { editor, keys } = await open('');
    await keys('word');
    await keys(CTRL('z'));
    assertEquals(editor.buffer.text, '');
    await keys(CTRL('y'));
    assertEquals(editor.buffer.text, 'word');
  });

  await t.step('a long line of code scrolls sideways to keep the cursor in view', async () => {
    const line = `  "${'x'.repeat(60)}END"`;
    const { terminal, keys } = await open(line, { lang: 'json' });
    await keys(END);
    assertStringIncludes(terminal.line(0), 'END"');
    assert(terminal.col < 40);
    // Home: the first non-blank fits on the first screen, so the indent comes back into view.
    await keys('\x1b[H');
    assert(terminal.line(0).startsWith(' 1   "xxx'), terminal.line(0));
  });

  await t.step('Markdown wraps, and ↓ moves one screen row', async () => {
    const text = 'A paragraph of prose long enough to wrap across rows.\nnext';
    const { editor, terminal, keys } = await open(text, { lang: 'markdown', cols: 24 });
    assertEquals(terminal.line(0), ' 1 A paragraph of prose');
    assertEquals(terminal.line(1), '   long enough to wrap');
    await keys(DOWN);
    assertEquals(editor.buffer.cursor, { line: 0, col: 21 });
    assertEquals([terminal.row, terminal.col], [1, 3]);
  });

  await t.step('the cursor keeps its column across a tab', async () => {
    const { editor, keys } = await open('\tx\nabcdef', { lang: 'yaml' });
    await keys(`${END}${DOWN}`);
    assertEquals(editor.buffer.cursor, { line: 1, col: 5 });
  });

  await t.step('the view scrolls down with the cursor and back up', async () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const { terminal, keys } = await open(text, { lang: 'yaml' });
    await keys(DOWN.repeat(20));
    assertEquals(terminal.line(terminal.row).trim(), '21 line 21');
    assertEquals(terminal.row, 7);
    await keys('\x1b[5~\x1b[5~\x1b[5~');
    assertEquals(terminal.line(0).trim(), '1 line 1');
  });

  await t.step('a shebang typed into a new file makes it a script', async () => {
    const { terminal, keys } = await open('', { cols: 70, language: (firstLine) => (firstLine === '#!bash' ? 'bash' : undefined) });
    assertStringIncludes(terminal.line(8), 'text');
    await keys('#!bash\rif true; then');
    assertStringIncludes(terminal.line(8), 'bash ✗');
    assertStringIncludes(terminal.line(8), 'unexpected end of file');
  });

  await t.step('a slow check waits for a pause in typing', async () => {
    // Each reading of the clock is 100 ms on: every check seems to take that long.
    let now = 0;
    const { editor, terminal, keys } = await open('{', { lang: 'json', cols: 70, now: () => (now += 100) });
    assertStringIncludes(terminal.line(8), 'JSON ✗');
    await keys(`${END}}`);
    assertStringIncludes(terminal.line(8), 'JSON …');
    assert(!terminal.text.includes('✗'));
    await new Promise((resolve) => setTimeout(resolve, 700));
    assertStringIncludes(terminal.line(8), 'JSON ✓');
    editor.close();
  });

  await t.step('saving checks a text whose check is still to come', async () => {
    let now = 0;
    const { editor, terminal, saves, keys } = await open('{}', { lang: 'json', cols: 70, now: () => (now += 100) });
    await keys('x');
    await keys('\x13');
    assertStringIncludes(terminal.line(9), 'Save with errors?');
    assertEquals(saves, []);
    editor.close();
  });

  await t.step('a resize redraws at the new size', async () => {
    const { editor, terminal } = await open('x');
    terminal.rows = 5;
    terminal.grid = terminal.grid.slice(0, 5);
    await editor.resize(5, 40);
    assertStringIncludes(terminal.line(3), 'file');
    assertStringIncludes(terminal.line(4), '^S Save');
  });
});
