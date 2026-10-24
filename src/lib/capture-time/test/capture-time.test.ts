/**
 * The capture-time vocabulary.
 *
 * Two properties carry most of the weight and are worth stating as tests rather than as
 * comments: a value's precision is recoverable from the value alone, and the UTC form of any
 * two values byte-sorts in the order the instants actually happened.
 */

import { assertEquals } from '@std/assert';
import {
  formatOffset,
  isCaptureTime,
  lowerBound,
  offsetOf,
  parseCaptureTime,
  periodBoundsUtc,
  precisionOf,
  toUtc,
  upperBoundExclusive,
  wallClockOf,
  withOffset,
} from '../mod.ts';

const STOCKHOLM = 'Europe/Stockholm';

Deno.test('precision comes from the value itself', () => {
  assertEquals(precisionOf('1975'), 'year');
  assertEquals(precisionOf('2004-03'), 'month');
  assertEquals(precisionOf('2003-04-30'), 'day');
  assertEquals(precisionOf('2003-04-30T14:03'), 'minute');
  assertEquals(precisionOf('2003-04-30T14:03:11'), 'second');
  assertEquals(precisionOf('2003-04-30T14:03:11+02:00'), 'second');
  assertEquals(precisionOf('2003-04-30T14:03:11Z'), 'second');
});

Deno.test('what is not a capture time', async (t) => {
  await t.step('the formats Date.parse accepts and this must not', () => {
    // `Date.parse` accepts it, but as bytes it would sort among the year 12s.
    assertEquals(isCaptureTime('12/25/2003'), false);
    assertEquals(isCaptureTime('Tue Mar 3 2020'), false);
    assertEquals(isCaptureTime('2003-4-3'), false);
  });

  await t.step('dates that do not exist', () => {
    assertEquals(isCaptureTime('2003-02-30'), false);
    assertEquals(isCaptureTime('2003-13-01'), false);
    assertEquals(isCaptureTime('2003-00-01'), false);
    assertEquals(isCaptureTime('2003-04-30T24:00'), false);
  });

  await t.step('outside the plausible span of photography', () => {
    assertEquals(isCaptureTime('1825'), false);
    assertEquals(isCaptureTime('1826'), true);
    assertEquals(isCaptureTime(String(new Date().getUTCFullYear() + 2)), false);
  });

  await t.step('but a *bound* may reach past the archive', () => {
    // `--at 2030` is how you say "start at the end". A ceiling that stops a camera claiming to
    // have shot next decade has no business stopping a question about next decade.
    const future = String(new Date().getUTCFullYear() + 5);
    assertEquals(isCaptureTime(future), false);
    assertEquals(lowerBound(future), future);
    assertEquals(upperBoundExclusive(future), String(Number(future) + 1));
    assertEquals(periodBoundsUtc(future, 'UTC')!.from, `${future}-01-01T00:00:00Z`);
  });

  await t.step('an offset on a value with no clock to offset', () => {
    assertEquals(isCaptureTime('1975+02:00'), false);
    assertEquals(isCaptureTime('2003-04-30+02:00'), false);
  });

  await t.step('a space instead of T, and fractional seconds', () => {
    // exiftool's own spelling is not a capture time.
    assertEquals(isCaptureTime('2003-04-30 14:03:11'), false);
    assertEquals(isCaptureTime('2003-04-30T14:03:11.5'), false);
  });
});

Deno.test('offsets', () => {
  assertEquals(offsetOf('2003-04-30T14:03:11+02:00'), 7200);
  assertEquals(offsetOf('2003-04-30T14:03:11-05:30'), -19800);
  assertEquals(offsetOf('2003-04-30T14:03:11Z'), 0);
  assertEquals(offsetOf('2003-04-30T14:03:11'), undefined);
  assertEquals(offsetOf('1975'), undefined);

  assertEquals(formatOffset(7200), '+02:00');
  assertEquals(formatOffset(-19800), '-05:30');
  assertEquals(formatOffset(0), '+00:00');

  assertEquals(wallClockOf('2003-04-30T14:03:11+02:00'), '2003-04-30T14:03:11');
  assertEquals(wallClockOf('2003-04-30T14:03:11'), '2003-04-30T14:03:11');

  assertEquals(withOffset('2003-04-30T14:03:11', 7200), '2003-04-30T14:03:11+02:00');
  assertEquals(withOffset('2003-04-30T14:03:11+05:00', 7200), '2003-04-30T14:03:11+02:00');
  // Nothing coarser than a minute gains one, because it names no clock.
  assertEquals(withOffset('1975', 7200), '1975');
  assertEquals(withOffset('2003-04-30', 7200), '2003-04-30');
});

Deno.test('toUtc', async (t) => {
  await t.step('an explicit offset is believed over the zone argument', () => {
    assertEquals(toUtc('2015-07-25T14:03:11+02:00', 'UTC'), '2015-07-25T12:03:11Z');
    assertEquals(toUtc('2015-07-25T12:03:11Z', STOCKHOLM), '2015-07-25T12:03:11Z');
  });

  await t.step("a bare wall clock is read in the given zone, with that date's DST", () => {
    assertEquals(toUtc('2015-07-25T14:03:11', STOCKHOLM), '2015-07-25T12:03:11Z');
    // Same wall clock in January: +01:00, not +02:00.
    assertEquals(toUtc('2015-01-25T14:03:11', STOCKHOLM), '2015-01-25T13:03:11Z');
  });

  await t.step('a partial value names the start of its period', () => {
    assertEquals(toUtc('1975', STOCKHOLM), '1974-12-31T23:00:00Z');
    assertEquals(toUtc('2004-03', STOCKHOLM), '2004-02-29T23:00:00Z');
    assertEquals(toUtc('2003-04-30', STOCKHOLM), '2003-04-29T22:00:00Z');
    assertEquals(toUtc('2003-04-30T14:03', STOCKHOLM), '2003-04-30T12:03:00Z');
  });

  await t.step('the UTC form is fixed width, so it byte-sorts as an instant', () => {
    // The whole point of the second attr: these two wall clocks sort the wrong way round as
    // text, and the right way round once converted.
    const tokyoNoon = '2015-07-25T12:00:00+09:00';
    const stockholmBreakfast = '2015-07-25T08:00:00+02:00';
    assertEquals(tokyoNoon > stockholmBreakfast, true);
    assertEquals(toUtc(tokyoNoon, STOCKHOLM)! < toUtc(stockholmBreakfast, STOCKHOLM)!, true);

    const all = ['1975', '2003-04-30', '2015-07-25T14:03:11+02:00'].map((v) => toUtc(v, STOCKHOLM)!);
    assertEquals(all.every((v) => v.length === 20 && v.endsWith('Z')), true);
  });

  await t.step('a value it cannot place yields nothing rather than a wrong instant', () => {
    assertEquals(toUtc('12/25/2003', STOCKHOLM), undefined);
    assertEquals(toUtc('2015-07-25T14:03:11', 'Not/AZone'), undefined);
  });
});

Deno.test('search bounds', async (t) => {
  await t.step('a bound is a wall clock, and keeps only that', () => {
    assertEquals(lowerBound(' 1995 '), '1995');
    assertEquals(lowerBound('1995-06'), '1995-06');
    assertEquals(lowerBound('2015-07-25T14:03:11+02:00'), '2015-07-25T14:03:11');
    assertEquals(lowerBound('notadate'), undefined);
  });

  await t.step('--to includes the whole period it names', () => {
    assertEquals(upperBoundExclusive('2000'), '2001');
    assertEquals(upperBoundExclusive('2000-12'), '2001-01');
    assertEquals(upperBoundExclusive('2000-06'), '2000-07');
    assertEquals(upperBoundExclusive('2000-06-15'), '2000-06-15T~');
    assertEquals(upperBoundExclusive('2000-06-15T14:03'), '2000-06-15T14:03:~');
    assertEquals(upperBoundExclusive('2000-06-15T14:03:11'), '2000-06-15T14:03:11~');
    assertEquals(upperBoundExclusive('notadate'), undefined);
  });

  await t.step('the bound covers a stored value however it is stamped', () => {
    // `~` sorts after every digit and after the +/-/Z an offset starts with, which is why the
    // bound is built by appending rather than by adding one to the last component.
    const to = upperBoundExclusive('2000-06-15')!;
    for (const stored of ['2000-06-15', '2000-06-15T23:59:59', '2000-06-15T23:59:59+02:00', '2000-06-15T00:00:00Z']) {
      assertEquals(stored < to, true, `${stored} should fall inside ${to}`);
    }
    assertEquals('2000-06-16' < to, false);

    const toSecond = upperBoundExclusive('2000-06-15T14:03:11')!;
    assertEquals('2000-06-15T14:03:11+02:00' < toSecond, true);
    assertEquals('2000-06-15T14:03:12' < toSecond, false);
  });
});

Deno.test('parts round-trip', () => {
  assertEquals(parseCaptureTime('2015-07-25T14:03:11+02:00'), {
    year: '2015',
    month: '07',
    day: '25',
    hour: '14',
    minute: '03',
    second: '11',
    offset: '+02:00',
    precision: 'second',
  });
  assertEquals(parseCaptureTime('1975'), {
    year: '1975',
    month: undefined,
    day: undefined,
    hour: undefined,
    minute: undefined,
    second: undefined,
    offset: undefined,
    precision: 'year',
  });
});

Deno.test('the instants a partial date spans', async (t) => {
  await t.step('a year, a month and a day each end where the next begins', () => {
    assertEquals(periodBoundsUtc('2000', STOCKHOLM), { from: '1999-12-31T23:00:00Z', to: '2000-12-31T23:00:00Z' });
    assertEquals(periodBoundsUtc('2000-12', STOCKHOLM), { from: '2000-11-30T23:00:00Z', to: '2000-12-31T23:00:00Z' });
    // Real calendar arithmetic, not a sentinel: 2000 was a leap year.
    assertEquals(periodBoundsUtc('2000-02-28', 'UTC'), { from: '2000-02-28T00:00:00Z', to: '2000-02-29T00:00:00Z' });
  });

  await t.step('across a DST boundary the period is 23 hours long, and says so', () => {
    // 2015-03-29 is when Sweden lost an hour.
    assertEquals(periodBoundsUtc('2015-03-29', STOCKHOLM), { from: '2015-03-28T23:00:00Z', to: '2015-03-29T22:00:00Z' });
  });

  await t.step('nothing comes of something that is not a date', () => {
    assertEquals(periodBoundsUtc('notadate', STOCKHOLM), undefined);
  });
});
