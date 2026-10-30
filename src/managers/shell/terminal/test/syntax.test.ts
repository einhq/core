import { assertEquals } from '@std/assert';
import { fencedBlocks, highlightLines, languageFor, type StyledLine, toAnsi } from '../syntax.ts';

/** The style of the run holding `text` on a line. */
const styleOf = (line: StyledLine, text: string) => line.find((run) => run.text.includes(text))?.style;

Deno.test('languageFor', async (t) => {
  await t.step('the extension decides first', () => {
    assertEquals(languageFor({ name: '/x/config.yml' }), 'yaml');
    assertEquals(languageFor({ name: 'deno.jsonc', mimetype: 'application/json' }), 'jsonc');
    // A .ts file is sometimes sniffed as an MPEG transport stream.
    assertEquals(languageFor({ name: 'main.ts', mimetype: 'video/mp2t' }), 'typescript');
    assertEquals(languageFor({ name: 'Makefile' }), 'makefile');
  });

  await t.step('then the mimetype, then a shebang', () => {
    assertEquals(languageFor({ name: 'notes', mimetype: 'text/markdown' }), 'markdown');
    assertEquals(languageFor({ name: 'run', mimetype: 'text/plain', firstLine: '#!bash' }), 'bash');
    assertEquals(languageFor({ name: 'run', firstLine: '#!/usr/bin/env bash' }), 'bash');
    assertEquals(languageFor({ name: 'notes.txt', mimetype: 'text/plain' }), undefined);
  });
});

Deno.test('highlightLines', async (t) => {
  await t.step('a string over two lines keeps its style on both', () => {
    const lines = highlightLines('x="one\ntwo" # done', 'bash');
    assertEquals(styleOf(lines[0], 'one'), '32');
    assertEquals(styleOf(lines[1], 'two'), '32');
    assertEquals(styleOf(lines[1], '# done'), '90');
  });

  await t.step('JSON keys, numbers and literals', () => {
    const [line] = highlightLines('{"a": 1, "b": true}', 'json');
    assertEquals(styleOf(line, '"a"'), '34');
    assertEquals(styleOf(line, '1'), '33');
    assertEquals(styleOf(line, 'true'), '33');
  });

  await t.step('plain text and unknown languages are unstyled, line for line', () => {
    assertEquals(highlightLines('a\n\nb'), [[{ text: 'a', style: '' }], [], [{ text: 'b', style: '' }]]);
    assertEquals(highlightLines('a', 'klingon'), [[{ text: 'a', style: '' }]]);
  });

  await t.step('Markdown prose, and a fenced block in its own language', () => {
    const lines = highlightLines('# Title\n\nSome **bold** text.\n```yaml\nkey: 1\n```\nafter', 'markdown');
    assertEquals(lines.length, 7);
    assertEquals(styleOf(lines[0], 'Title'), '1;34');
    assertEquals(styleOf(lines[2], 'bold'), '1');
    assertEquals(styleOf(lines[3], '```yaml'), '90');
    assertEquals(styleOf(lines[4], 'key:'), '34');
    assertEquals(styleOf(lines[5], '```'), '90');
  });

  await t.step('a console block is a session: the prompt dimmed, the command as bash, its output plain', () => {
    const lines = highlightLines('```console\n$ echo "hi"\nhi (done\n```', 'markdown');
    assertEquals(styleOf(lines[1], '$ '), '90');
    assertEquals(styleOf(lines[1], 'echo'), '35');
    assertEquals(styleOf(lines[1], '"hi"'), '32');
    assertEquals(styleOf(lines[2], 'hi (done'), '');
  });

  await t.step('an unclosed fence runs to the end', () => {
    const lines = highlightLines('```json\n{"a": 1}\n# not a heading', 'markdown');
    assertEquals(styleOf(lines[1], '"a"'), '34');
    assertEquals(styleOf(lines[2], '# not a heading'), '');
  });

  await t.step('Markdown with more lines than a call takes arguments', () => {
    assertEquals(highlightLines('\n'.repeat(200_000), 'markdown').length, 200_001);
  });

  await t.step('toAnsi closes every run, so lines can be cut apart', () => {
    assertEquals(toAnsi(highlightLines('a: 1\nb: 2', 'yaml')).split('\n').length, 2);
    assertEquals(toAnsi([[{ text: 'x', style: '32' }, { text: 'y', style: '' }]]), '\x1b[32mx\x1b[0my');
  });
});

Deno.test('fencedBlocks', () => {
  const lines = ['~~~sh', 'echo', '~~~', 'text', '````md', '```', 'inner', '````'];
  assertEquals(fencedBlocks(lines), [
    { lang: 'bash', fence: 0, body: 1, end: 2 },
    { lang: 'markdown', fence: 4, body: 5, end: 7 },
  ]);
});
