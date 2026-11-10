import { assertEquals } from '@std/assert';
import { formatRange } from '../format.ts';

Deno.test('formatRange keeps the precision a date was recorded with, in Swedish by default', () => {
  assertEquals(formatRange('1966'), '1966');
  assertEquals(formatRange('1966-04'), 'apr. 1966');
  assertEquals(formatRange('1966-04-03'), '3 apr. 1966');
  assertEquals(formatRange('1966', '1968'), '1966 – 1968');
  assertEquals(formatRange('1998-06-12T14:03:00', '1998-06-14T21:00:00'), '12 juni 1998 – 14 juni 1998');
  // One day, however many times of it.
  assertEquals(formatRange('1998-06-12T09:00:00', '1998-06-12T21:00:00'), '12 juni 1998');
  assertEquals(formatRange(undefined), '');
});
