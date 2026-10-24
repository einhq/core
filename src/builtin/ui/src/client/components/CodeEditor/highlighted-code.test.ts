import { assertEquals } from '@std/assert';
import { highlightRanges } from './HighlightedCode.tsx';

/** Each classed run as `class:text`, the plain ones dropped. */
const classed = (code: string, language = '') =>
  highlightRanges(code, language).filter((range) => range.className).map((range) => `${range.className!.replace('mrx-tok-', '')}:${range.text}`);

Deno.test('a command line: the command, its flags, values, strings and the next command', () => {
  assertEquals(classed('search --limit=5 "a sailboat" | head -n 3'), [
    'command:search',
    'flag:--limit=',
    'number:5',
    'string:"a sailboat"',
    'operator:|',
    'command:head',
    'flag:-n',
    'number:3',
  ]);
});

Deno.test('a prefix assignment is not the command; the word after it is', () => {
  assertEquals(classed('JSON_OUTPUT=1 docs env # every variable'), ['definition:JSON_OUTPUT=1', 'command:docs', 'comment:# every variable']);
});

Deno.test('each line starts a command, and variables are marked', () => {
  assertEquals(classed('cd $ALBUMS_PATH\nls -l'), ['command:cd', 'variable:$ALBUMS_PATH', 'command:ls', 'flag:-l']);
});

Deno.test('a synopsis placeholder is a placeholder, not a redirect', () => {
  assertEquals(classed('album-stack [options] <action> <file>…'), ['command:album-stack', 'meta:[options]', 'meta:<action>', 'meta:<file>…']);
  assertEquals(classed('ls > out'), ['command:ls', 'operator:>']);
});

Deno.test('a negative value after a flag is a number, not a flag', () => {
  assertEquals(classed('location-locate --lng=-122.3'), ['command:location-locate', 'flag:--lng=', 'number:-122.3']);
});

Deno.test('other languages use their own parser; an unknown one is plain', () => {
  assertEquals(classed('{"a": 1}', 'json').includes('number:1'), true);
  assertEquals(highlightRanges('ls -l', 'text'), [{ text: 'ls -l' }]);
});
