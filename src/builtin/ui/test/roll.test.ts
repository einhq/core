import { assertEquals } from '@std/assert';
import { rollStops } from '../src/client/lib/roll.ts';

Deno.test('a rolling list rests at each line, then at its copy', () => {
  // Rows of different heights, each a line of its own.
  assertEquals(rollStops([0, 40.5, 81, 150.25], 210.5), [0, 40.5, 81, 150.25, 210.5]);
});

Deno.test("a grid's tiles in one row are one line, a pixel's difference or not", () => {
  assertEquals(rollStops([0, 0, 0.4, 96, 96.6, 96, 192], 300), [0, 96, 192, 300]);
});

Deno.test('rows out of order, or at or past the copy, are not stops of their own', () => {
  assertEquals(rollStops([81, 0, 40], 120), [0, 40, 81, 120]);
  assertEquals(rollStops([0, 50, 120, 130], 120), [0, 50, 120]);
});

Deno.test('a list whose first row does not start at its top still rests at its top first', () => {
  assertEquals(rollStops([12, 60], 100), [0, 12, 60, 100]);
});

Deno.test('a single line, however long, has no line to roll to', () => {
  // How RollingList asks whether a list has more than one line, before its copy is drawn.
  assertEquals(rollStops([0, 0.3, 0], Infinity).length, 2);
  assertEquals(rollStops([0, 96], Infinity).length, 3);
});
