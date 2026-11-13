/**
 * The occasions `search --occasion` knows: holidays on the Swedish calendar, each the days it
 * falls on in a given year, named in each language the archive can be in.
 *
 * A model asked for "pictures from midsummer" cannot be trusted to work out which days those are
 * (ein/core#328), and Easter moves; a name is what it can be trusted with, and the days are worked
 * out here, for every year asked, as one store condition.
 */

import type { AttrCondition } from '../../vfs/query.ts';
import { TAKEN_AT } from './filters.ts';

/** The first and the day after the last of an occasion in one year, as UTC dates. */
type Days = (year: number) => [Date, Date];

type Occasion = { names: string[]; days: Days };

const day = (year: number, month: number, date: number): Date => new Date(Date.UTC(year, month - 1, date));

const plus = (date: Date, days: number): Date => new Date(date.getTime() + days * 86_400_000);

/** Easter Sunday of a Gregorian year (the anonymous Gregorian algorithm). */
export const easterSunday = (year: number): Date => {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const n = h + l - 7 * m + 114;
  return day(year, Math.floor(n / 31), (n % 31) + 1);
};

/** The one Friday from 19 to 25 June: midsummer's eve. */
const midsummerEve = (year: number): Date => {
  const first = day(year, 6, 19);
  return plus(first, (5 - first.getUTCDay() + 7) % 7);
};

const OCCASIONS: Occasion[] = [
  // Midsummer's eve to midsummer's day's Sunday.
  { names: ['midsummer', 'midsommar'], days: (year) => [midsummerEve(year), plus(midsummerEve(year), 3)] },
  // Good Friday to Easter Monday.
  { names: ['easter', 'påsk'], days: (year) => [plus(easterSunday(year), -2), plus(easterSunday(year), 2)] },
  // Christmas Eve to Boxing Day.
  { names: ['christmas', 'jul'], days: (year) => [day(year, 12, 24), day(year, 12, 27)] },
  // New Year's Eve and the day after: the year is the eve's.
  { names: ['new-year', 'nyår'], days: (year) => [day(year, 12, 31), day(year + 1, 1, 2)] },
  { names: ['walpurgis', 'valborg'], days: (year) => [day(year, 4, 30), day(year, 5, 1)] },
  { names: ['national-day', 'nationaldagen'], days: (year) => [day(year, 6, 6), day(year, 6, 7)] },
  { names: ['lucia'], days: (year) => [day(year, 12, 13), day(year, 12, 14)] },
];

/** Every name an occasion answers to, for help and for the error that refuses another. */
export const OCCASION_NAMES: string[] = OCCASIONS.flatMap((occasion) => occasion.names);

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * The occasion named, as the capture times inside it in each year from `firstYear` to `lastYear`:
 * a `ranges` condition on the wall clock. Undefined for a name no occasion has.
 */
export const occasionCondition = (name: string, firstYear: number, lastYear: number): AttrCondition | undefined => {
  const wanted = name.trim().toLowerCase();
  const occasion = OCCASIONS.find((candidate) => candidate.names.includes(wanted));
  if (!occasion) return undefined;
  const value: [string, string][] = [];
  for (let year = firstYear; year <= lastYear; year++) {
    const [from, to] = occasion.days(year);
    value.push([isoDay(from), isoDay(to)]);
  }
  return { ref: TAKEN_AT, op: 'ranges', value };
};
