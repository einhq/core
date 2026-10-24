/**
 * An empty value after an option is that option's value, not a positional: `--text '' <file>`
 * clears the text of `<file>`.
 */

import { assertEquals } from '@std/assert';
import { parseArgs } from '../mod.ts';

Deno.test('an empty value after a long option is its value', () => {
  assertEquals(parseArgs(['--text', '', '/a/b'], { string: ['text'] }), { _: ['/a/b'], text: '' });
});

Deno.test('an empty value after a short option, alias or not, is its value', () => {
  assertEquals(parseArgs(['-t', '', '/a/b'], { string: ['t'] }), { _: ['/a/b'], t: '' });
  assertEquals(parseArgs(['-t', '', '/a/b'], { string: ['text'], alias: { t: 'text' } }), { _: ['/a/b'], t: '', text: '' });
});

Deno.test('a boolean, an undeclared option and anything after -- keep an empty argument as a positional', () => {
  assertEquals(parseArgs(['-v', '', 'x'], { boolean: ['v'] }), { _: ['', 'x'], v: true });
  assertEquals(parseArgs(['--', '--text', ''], { string: ['text'] }), { _: ['--text', ''] });
});

Deno.test('a value that is there is still read as before', () => {
  assertEquals(parseArgs(['--text', 'hej', '/a/b'], { string: ['text'] }), { _: ['/a/b'], text: 'hej' });
  assertEquals(parseArgs(['-d:', 'x'], { string: ['d'] }), { _: ['x'], d: ':' });
});
