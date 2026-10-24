/**
 * Positionals reach a command exactly as written, whatever they look like: `007`, a 19-digit id
 * and `1e3` are strings, not numbers.
 */

import { assertEquals } from '@std/assert';
import { parseArgs } from '../mod.ts';

Deno.test('a numeric-looking positional stays the string it was', () => {
  const ids = ['007', '1828138343960299923', '1e3', '0x10', '-0', '5.50'];
  assertEquals(parseArgs(['--', ...ids])._, ids);
  assertEquals(parseArgs(['007', '1828138343960299923', '1e3', '0x10', '5.50'])._, ['007', '1828138343960299923', '1e3', '0x10', '5.50']);
});

Deno.test('positionals are strings beside declared options', () => {
  const flags = parseArgs(['-n', '5', '42', '--', '43'], { string: ['n'], boolean: ['q'] });
  assertEquals(flags, { _: ['42', '43'], n: '5', q: false });
  // Typed so: a command converts a positional it wants as a number itself.
  const positionals: string[] = flags._;
  assertEquals(positionals.map(Number), [42, 43]);
});

Deno.test("a command's own string list and an explicit '_' still work", () => {
  assertEquals(parseArgs(['12', '--name', '34'], { string: ['name'] }), { _: ['12'], name: '34' });
  assertEquals(parseArgs(['12'], { string: ['_'] }), { _: ['12'] });
  assertEquals(parseArgs(['12'], { string: '_' }), { _: ['12'] });
});
