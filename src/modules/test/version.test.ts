/**
 * Which versions a module's dependency range takes.
 */

import { assertEquals } from '@std/assert';
import { parse, parseRange } from '@std/semver';
import { inRange } from '../version.ts';

Deno.test('a prerelease is in the ranges of the release it leads to', () => {
  const cases: [string, string, boolean][] = [
    ['0.6.0-dev.3', '^0.6.0', true],
    ['0.6.0-dev.3', '>=0.5.0', true],
    ['0.6.0-dev.3', '^0.5.0', false],
    ['0.5.3-dev.1', '^0.5.0', true],
    ['1.2.0-dev.1', '^1.1.0', true],
    ['1.2.0-dev.1', '>=1.2.1', false],
    ['0.6.0', '^0.6.0', true],
  ];
  for (const [version, range, expected] of cases) assertEquals(inRange(parse(version), parseRange(range)), expected, `${version} in ${range}`);
});
