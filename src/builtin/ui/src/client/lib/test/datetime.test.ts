import { assertEquals } from '@std/assert';
import { timeLocale } from '../../signals/config.ts';
import { formatDate, formatDateTime, formatTime } from '../datetime.ts';

const at = new Date(2026, 10, 9, 13, 26, 5);

Deno.test('datetime: a 24-hour clock and the date year first by default, whatever the browser speaks', () => {
  assertEquals(formatDateTime(at), '2026-11-09, 13:26:05');
  assertEquals(formatDate(at), '2026-11-09');
  assertEquals(formatTime(at, { hour: '2-digit', minute: '2-digit' }), '13:26');
});

Deno.test("datetime: the reader's locale decides the clock and the order", () => {
  timeLocale.value = 'en-US';
  try {
    assertEquals(formatDateTime(at), '11/9/2026, 1:26:05 PM');
    assertEquals(formatDate(at, { day: 'numeric', month: 'short' }), 'Nov 9');
  } finally {
    timeLocale.value = 'en-SE';
  }
});

Deno.test('datetime: a time that is none reads as one', () => {
  assertEquals(formatDateTime('not a time'), 'Invalid Date');
});
