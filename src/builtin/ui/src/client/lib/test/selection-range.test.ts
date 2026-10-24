/**
 * rangeSelect: shift-click over a flat media list.
 *
 * The point of extending the *snapshot* rather than the current selection is that a range
 * can be redrawn — shift-click far ahead, then shift-click back, and the items in between
 * must let go instead of staying stuck on.
 */

import { assertEquals } from '@std/assert';
import { rangeSelect } from '../selection-range.ts';

const ORDER = new Map(['a', 'b', 'c', 'd', 'e'].map((path, index) => [path, index]));

const sorted = (set: Set<string>) => [...set].sort();

Deno.test('a range covers everything between the anchor and the click', () => {
  assertEquals(sorted(rangeSelect(new Set(['a']), ORDER, 'a', 'c')), ['a', 'b', 'c']);
});

Deno.test('a range runs backwards just as well', () => {
  assertEquals(sorted(rangeSelect(new Set(['d']), ORDER, 'd', 'b')), ['b', 'c', 'd']);
});

Deno.test('redrawing a range from the same base shrinks it', () => {
  const base = new Set(['a']);
  const wide = rangeSelect(base, ORDER, 'a', 'e');
  assertEquals(sorted(wide), ['a', 'b', 'c', 'd', 'e']);

  // Same base, nearer click — the far items were never in the base, so they drop out.
  assertEquals(sorted(rangeSelect(base, ORDER, 'a', 'b')), ['a', 'b']);
});

Deno.test('a range keeps selections made outside it', () => {
  assertEquals(sorted(rangeSelect(new Set(['a', 'e']), ORDER, 'a', 'b')), ['a', 'b', 'e']);
});

Deno.test('without an anchor a range is a plain add', () => {
  assertEquals(sorted(rangeSelect(new Set(['a']), ORDER, null, 'd')), ['a', 'd']);
});

Deno.test('an anchor that scrolled out of the list degrades to a plain add', () => {
  assertEquals(sorted(rangeSelect(new Set(['a']), ORDER, 'gone', 'd')), ['a', 'd']);
});

Deno.test('a range to the anchor itself selects just the anchor', () => {
  assertEquals(sorted(rangeSelect(new Set(), ORDER, 'c', 'c')), ['c']);
});
