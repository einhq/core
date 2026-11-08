/** How the device pages write a value and a time: on and off for a state, a number with its unit, a dash for none. */

import type { DeviceValue } from '@ein/api';

export const readingText = (value: DeviceValue | undefined, unit?: string): string => {
  if (value === null || value === undefined) return '–';
  if (value === true) return 'on';
  if (value === false) return 'off';
  if (typeof value === 'number') {
    const shown = Math.abs(value) >= 100 ? value.toFixed(0) : String(Number(value.toFixed(2)));
    return unit ? `${shown} ${unit}` : shown;
  }
  return unit ? `${value} ${unit}` : value;
};

/** How long ago `at` was, in a few words. */
export const agoText = (at: string | undefined, now = Date.now()): string => {
  if (!at) return 'never';
  const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
};

/** A time as the Chart spaces its line by: the local date, hour and minute (`2026-11-08 20:30`). */
export const chartLabel = (at: string): string => {
  const time = new Date(at);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${time.getFullYear()}-${two(time.getMonth() + 1)}-${two(time.getDate())} ${two(time.getHours())}:${two(time.getMinutes())}`;
};

/** Whether what a device reported is what was asked of it, a number and its text (`21.5`, `"21.5"`) alike. */
export const sameValue = (a: DeviceValue | undefined, b: DeviceValue | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a !== null && b !== null && String(a) === String(b));
