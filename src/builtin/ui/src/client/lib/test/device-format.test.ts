import { assert, assertEquals } from '@std/assert';
import { allDates } from '../../components/Chart/plots.tsx';
import { agoText, chartLabel, readingText, sameValue } from '../device-format.ts';

Deno.test('device format: a value is on or off, a number with its unit, a dash for none', () => {
  assertEquals(readingText(true), 'on');
  assertEquals(readingText(false), 'off');
  assertEquals(readingText(null), '–');
  assertEquals(readingText(undefined, '°C'), '–');
  assertEquals(readingText(21.456, '°C'), '21.46 °C');
  assertEquals(readingText(1234.5, 'W'), '1235 W');
  assertEquals(readingText('heat'), 'heat');
});

Deno.test('device format: how long ago, in a few words', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  assertEquals(agoText(undefined, now), 'never');
  assertEquals(agoText('2026-11-08T11:59:30Z', now), 'just now');
  assertEquals(agoText('2026-11-08T11:45:00Z', now), '15 min ago');
  assertEquals(agoText('2026-11-08T09:00:00Z', now), '3 h ago');
  assertEquals(agoText('2026-11-06T12:00:00Z', now), '2 d ago');
});

Deno.test('device format: a chart label is one the Chart spaces its line by', () => {
  const labels = ['2026-11-08T00:05:00Z', '2026-11-08T20:30:00Z'].map(chartLabel);
  assert(allDates(labels), labels.join(', '));
  assertEquals(labels[0].length, '2026-11-08 20:30'.length);
});

Deno.test('device format: a reported value matches what was asked, a number and its text alike', () => {
  assert(sameValue(21.5, '21.5'));
  assert(sameValue(true, true));
  assert(!sameValue(true, false));
  assert(!sameValue(null, 'null'));
  assert(!sameValue(undefined, 'on'));
});
