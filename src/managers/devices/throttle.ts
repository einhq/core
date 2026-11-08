/**
 * When a reading is published. A reading that repeats the last one published is not; a number is
 * published at most once every `minIntervalMs`, and one that comes sooner waits for the end of the
 * interval, replaced by any later one, so the last value of a burst is never lost. Anything else —
 * on and off, a word — is published as soon as it changes.
 */

import type { DeviceValue } from '../../lib/api/devices.ts';

export type Published = { value: DeviceValue; at: number };

type Decision =
  | { publish: 'now' }
  | { publish: 'later'; at: number }
  | { publish: 'no' };

export const decide = (last: Published | undefined, value: DeviceValue, now: number, minIntervalMs: number): Decision => {
  if (!last) return { publish: 'now' };
  if (last.value === value) return { publish: 'no' };
  if (typeof value !== 'number' || typeof last.value !== 'number') return { publish: 'now' };
  const due = last.at + minIntervalMs;
  return now >= due ? { publish: 'now' } : { publish: 'later', at: due };
};
