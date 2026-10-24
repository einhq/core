import { SYSTEM_TIME_ZONE } from './timezone.ts';

type DateTimeObject = {
  day: string;
  month: string;
  year: string;
  hour: string;
  minute: string;
  second: string;
};

/**
 * An instant, in the parts `ls -l` and friends print.
 *
 * Rendered in `SYSTEM_TIME_ZONE`, not UTC, so it agrees with the log prefix whatever `TZ` is.
 */
export const stampToObject = (timestamp: number): DateTimeObject => {
  const instant = Temporal.Instant.fromEpochMilliseconds(timestamp);
  const plainDateTime = instant.toZonedDateTimeISO(SYSTEM_TIME_ZONE).toPlainDateTime();

  const day = `${plainDateTime.day}`;
  const month = (new Intl.DateTimeFormat('en-US', { month: 'short' }).format(plainDateTime)).split(' ')[0];
  const year = `${plainDateTime.year}`;
  const hour = `${plainDateTime.hour}`.padStart(2, '0');
  const minute = `${plainDateTime.minute}`.padStart(2, '0');
  const second = `${plainDateTime.second}`.padStart(2, '0');

  return {
    day,
    month,
    year,
    hour,
    minute,
    second,
  };
};
