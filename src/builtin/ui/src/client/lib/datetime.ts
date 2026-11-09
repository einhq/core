import { timeLocale } from '../signals/config.ts';

/**
 * Dates and times as the reader's settings write them, never as the browser's language would.
 *
 * `toLocaleString()` and a bare `Intl.DateTimeFormat` follow the browser's language, so an English
 * browser shows a 12-hour clock and the same page reads differently per viewer. These follow
 * `timeLocale` instead (`CFG_USER_TIME_LOCALE` over `CFG_TIME_LOCALE`), and take the options
 * `toLocaleString` and its siblings take, with the same defaults.
 */

type When = Date | number | string;

const DATE: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric' };
const TIME: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: 'numeric', second: 'numeric' };
const DATE_TIME: Intl.DateTimeFormatOptions = { ...DATE, ...TIME };

const formats = new Map<string, Intl.DateTimeFormat>();

/**
 * An `Intl.DateTimeFormat` in the reader's locale, made once per locale and options: making one
 * takes far longer than formatting with it.
 */
export function dateTimeFormat(options: Intl.DateTimeFormatOptions = DATE): Intl.DateTimeFormat {
  const locale = timeLocale.value;
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = formats.get(key);
  if (!format) formats.set(key, format = new Intl.DateTimeFormat(locale, options));
  return format;
}

const write = (at: When, options: Intl.DateTimeFormatOptions): string => {
  const date = at instanceof Date ? at : new Date(at);
  return Number.isNaN(date.getTime()) ? 'Invalid Date' : dateTimeFormat(options).format(date);
};

/** A date and time, like `toLocaleString`: 2026-11-09, 13:26:00 in `en-SE`. */
export const formatDateTime = (at: When, options: Intl.DateTimeFormatOptions = DATE_TIME): string => write(at, options);

/** A date, like `toLocaleDateString`: 2026-11-09 in `en-SE`. */
export const formatDate = (at: When, options: Intl.DateTimeFormatOptions = DATE): string => write(at, options);

/** A time of day, like `toLocaleTimeString`: 13:26:00 in `en-SE`. */
export const formatTime = (at: When, options: Intl.DateTimeFormatOptions = TIME): string => write(at, options);
