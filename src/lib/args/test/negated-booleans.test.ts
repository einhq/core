/**
 * `--no-x` turns off a declared boolean `x` and leaves the argument after it alone; an undeclared
 * `--no-x` is an unknown flag.
 */

import { assertEquals } from '@std/assert';
import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '../mod.ts';

const parse = (args: string[], options: Parameters<typeof parseArgs>[1]) => {
  const unknown: string[] = [];
  const flags = parseArgs(args, { ...options, unknown: collectUnknownFlags(unknown) });
  return { flags, unknown };
};

Deno.test('--no-x sets a declared boolean to false and keeps the next argument as a positional', () => {
  assertEquals(parse(['-l', '--no-a', '/var'], { boolean: ['l', 'a'] }), {
    flags: { _: ['/var'], l: true, a: false },
    unknown: [],
  });
  assertEquals(parse(['--no-mirror', '/x'], { boolean: ['mirror'], default: { mirror: true } }), {
    flags: { _: ['/x'], mirror: false },
    unknown: [],
  });
});

Deno.test('a declared no-x boolean is set by --no-x', () => {
  assertEquals(parse(['--no-relink', '/a', '/b'], { boolean: ['relink', 'no-relink'] }).flags, {
    _: ['/a', '/b'],
    relink: false,
    'no-relink': true,
  });
});

Deno.test('an undeclared --no-x is reported', async () => {
  const { unknown } = parse(['--no-bogus', '/x'], { boolean: ['a'] });
  assertEquals(unknown, ['--no-bogus']);

  const errors: string[] = [];
  const sink = { name: 'ls', writeError: (data: string) => Promise.resolve(void errors.push(data)) };
  assertEquals(await reportUnknownFlags(sink, unknown), true);
  assertEquals(errors, ['ls: unknown flag --no-bogus\n']);
});
