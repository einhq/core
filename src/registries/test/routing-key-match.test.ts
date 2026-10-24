/**
 * The pattern semantics both backends depend on. Everything here is also what the PG registries
 * store as a regex source and hand to postgres, so a case that passes in JS and not in postgres is
 * a bug in the emitted source — `pg-queue.test.ts` re-runs this table against postgres for exactly
 * that reason.
 */

import { assert, assertEquals, assertFalse } from '@std/assert';
import { MATCH_CASES } from './routing-key-cases.ts';
import { compiledKeysMatch, compileRoutingKeys, isRoutingPattern, routingKeysMatch, routingPatternSources, routingPatternToRegexSource } from '../routing-key-match.ts';

Deno.test('pattern matching follows AMQP topic semantics', () => {
  for (const [pattern, key, expected] of MATCH_CASES) {
    assertEquals(
      routingKeysMatch([pattern], key),
      expected,
      `${pattern} vs ${key} should be ${expected}`,
    );
  }
});

Deno.test('only whole-segment wildcards make a key a pattern', () => {
  assert(isRoutingPattern('system.vfs.file.*'));
  assert(isRoutingPattern('#'));
  assert(isRoutingPattern('a.#.b'));
  assertFalse(isRoutingPattern('system.vfs.file.created'));
  // A key that merely contains the characters still matches only itself, so treating it as a
  // pattern would bind more than the consumer asked for.
  assertFalse(isRoutingPattern('system.vfs.fi*.created'));
  assertFalse(isRoutingPattern('a#b'));
});

Deno.test('regex metacharacters in a literal segment stay literal', () => {
  // `.` is the separator, so a segment cannot contain one — but the rest of the class can, and an
  // unescaped `(` would throw rather than fail to match.
  assert(routingKeysMatch(['a.b+c.*'], 'a.b+c.d'));
  assertFalse(routingKeysMatch(['a.b+c.*'], 'a.bbc.d'));
  assert(routingKeysMatch(['a.(b).#'], 'a.(b).c'));
  assert(routingKeysMatch(['a.b[c].*'], 'a.b[c].d'));
});

Deno.test('a key list matches if any of its keys does', () => {
  const keys = ['system.vfs.file.created', 'media.#'];

  assert(routingKeysMatch(keys, 'system.vfs.file.created'));
  assert(routingKeysMatch(keys, 'media.face.detected'));
  assertFalse(routingKeysMatch(keys, 'system.vfs.tty.updated'));
  assertFalse(routingKeysMatch([], 'system.vfs.file.created'));
});

Deno.test('compileRoutingKeys splits exact from pattern', () => {
  const compiled = compileRoutingKeys(['system.vfs.file.created', 'media.#', 'system.events']);

  assertEquals(compiled.exact.size, 2);
  assertEquals(compiled.patterns.length, 1);

  assert(compiledKeysMatch(compiled, 'system.events'));
  assert(compiledKeysMatch(compiled, 'media.file.discovered'));
  assertFalse(compiledKeysMatch(compiled, 'system.vfs.tty.updated'));
});

Deno.test('only patterns reach the routing_patterns column', () => {
  // Exact keys are served by the indexed branch; repeating them as regexes would push the common
  // case onto the scan.
  assertEquals(routingPatternSources(['system.vfs.file.created']), []);
  assertEquals(routingPatternSources(['media.#']), [routingPatternToRegexSource('media.#')]);
});
