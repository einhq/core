/**
 * The rules a track's fixes go through as they are stored.
 *
 * A fix is kept whatever it says, and the rules judge it against its
 * neighbours. A leap is a single step of more than `JUMP_MIN_M`, taken in at
 * most `JUMP_MAX_GAP_MS` (over a longer gap it is a pause, which a read cuts
 * anyway). A jump is a leap faster than `JUMP_MIN_SPEED`: impossible for
 * anything a track records on the ground or the water.
 *
 * - **excursion**: a run of fixes the track leaps into and back out of, to
 *   near where it was, within `EXCURSION_MAX_MS`, where at least one of the
 *   two leaps is a jump. Every fix of the run is rejected: a receiver on a bad
 *   fix, or a phone falling back to a cell position, can hold a smooth and
 *   wrong track out there for minutes. A jump can be read either way — out
 *   into a run that comes back later, or back from a run entered earlier
 *   without hurry — and the shorter run is the excursion.
 * - **excursion**, too: a fix a leap lands on at exactly the position the track
 *   had earlier, and the fixes that stay there, when the track has been away
 *   from it for at least as many fixes as it was there. A phone that loses
 *   its fix falls back to the last position a cell or a network gave it, and
 *   a real fix does not repeat one to the last decimal after the track has
 *   been away for long; coming back from a spike to where it lay is the
 *   other way round. These go first, so the rest is judged without them.
 * - **jump**: a jump that is no part of an excursion, with steady going on
 *   both sides of it, as when a logger starts again somewhere else. The fixes
 *   are fine; the line is cut before the fix it lands on.
 *
 * The jump has steady going on the track's side of it, which is what keeps a
 * logger on an aircraft out of both rules: every one of its steps is fast.
 */
import { haversineMeters } from '../../lib/geo/distance.ts';

export type TrackRule = 'excursion' | 'jump';

/** A fix as the rules see it: time in epoch ms and position. */
export type RuleFix = { ms: number; lat: number; lng: number };

/** A step shorter than this is never a jump, however fast it looks. */
export const JUMP_MIN_M = 1000;

/** 600 km/h, in m/s: faster than a car or a boat, slower than the jumps a bad fix makes. */
const JUMP_MIN_SPEED = 600 / 3.6;

/** A step over a longer gap than this is a pause, not a jump. */
export const JUMP_MAX_GAP_MS = 30 * 60_000;

/** An excursion lasts at most this long, from the first fix out to the last. */
const EXCURSION_MAX_MS = 2 * 60 * 60_000;

/**
 * How far in time a fix's verdict can depend on other fixes. Whoever judges
 * the fixes of a window reads this much more on each side.
 */
export const RULES_REACH_MS = EXCURSION_MAX_MS + JUMP_MAX_GAP_MS;

/**
 * The version of these rules. A track judged by an older version is judged
 * again; raise it when a rule or a threshold changes.
 */
export const RULES_VERSION = 1;

const distance = (a: RuleFix, b: RuleFix): number => haversineMeters(a.lat, a.lng, b.lat, b.lng);

/** Speed in m/s of the step between two fixes, over at least a second. */
const speed = (a: RuleFix, b: RuleFix): number => distance(a, b) / (Math.max(b.ms - a.ms, 1000) / 1000);

/** Whether the step from `a` to `b` is a leap: long, and not over a pause. */
const leaps = (a: RuleFix, b: RuleFix): boolean => b.ms - a.ms <= JUMP_MAX_GAP_MS && distance(a, b) > JUMP_MIN_M;

/** Within this of a position, the track is still there. */
const HELD_M = 100;

/**
 * Which fixes are a position the track fell back to: reached by a leap at
 * exactly a position it had within `RULES_REACH_MS` before, having been away
 * from it at least as many fixes as it stayed there then, with the fixes that
 * stay on it now.
 */
function fallbacks(fixes: RuleFix[]): boolean[] {
  const stale: boolean[] = new Array(fixes.length).fill(false);
  const seen = new Map<string, number>();

  for (let i = 0; i < fixes.length; i++) {
    const key = `${fixes[i].lat},${fixes[i].lng}`;
    const earlier = seen.get(key);
    seen.set(key, i);

    if (i === 0) continue;
    if (stale[i - 1] && fixes[i].lat === fixes[i - 1].lat && fixes[i].lng === fixes[i - 1].lng) {
      stale[i] = true;
      continue;
    }
    if (earlier === undefined || fixes[i].ms - fixes[earlier].ms > RULES_REACH_MS || !leaps(fixes[i - 1], fixes[i])) continue;

    let held = 1;
    while (earlier - held >= 0 && held <= i - earlier && distance(fixes[earlier - held], fixes[i]) <= HELD_M) held++;
    stale[i] = i - earlier - 1 >= held;
  }

  return stale;
}

/**
 * Judge time-ordered fixes. Returns each fix's rule, or null for a fix that is
 * accepted and joined to the one before it.
 */
export function judgeFixes(all: RuleFix[]): (TrackRule | null)[] {
  const stale = fallbacks(all);
  const kept = all.flatMap((_, i) => stale[i] ? [] : [i]);
  const fixes = kept.map((i) => all[i]);
  const n = fixes.length;
  const rules: (TrackRule | null)[] = new Array(n).fill(null);

  // Step i is the one from fix i - 1 to fix i; there is none before fix 0 or after the last.
  const fast = (i: number): boolean => i > 0 && i < n && speed(fixes[i - 1], fixes[i]) > JUMP_MIN_SPEED;
  const leap = (i: number): boolean => i > 0 && i < n && leaps(fixes[i - 1], fixes[i]);

  // The last fix of the last excursion and the fix it came back on: a run never reaches back over
  // them, and the step after the fix it came back on starts from accepted ground.
  let done = 0;
  let back = -1;

  for (let i = 1; i < n; i++) {
    if (!leap(i) || !fast(i)) continue;

    const from = fixes[i - 1];
    const to = fixes[i];
    const near = distance(from, to) / 2;

    // Out: the run starts at i and ends where a leap lands back near `from`.
    let end = -1;
    if (!fast(i - 1) || i - 1 === back) {
      for (let k = i + 1; k < n && fixes[k - 1].ms - to.ms <= EXCURSION_MAX_MS; k++) {
        if (leap(k) && distance(from, fixes[k]) < near) {
          end = k;
          break;
        }
      }
    }

    // Back: the run ends at i - 1 and starts where a leap left from near `to`.
    let start = -1;
    if (!fast(i + 1)) {
      for (let k = i - 1; k > done && from.ms - fixes[k].ms <= EXCURSION_MAX_MS; k--) {
        if (leap(k) && distance(fixes[k - 1], to) < near) {
          start = k;
          break;
        }
      }
    }

    if (end >= 0 && (start < 0 || end - i <= i - start)) {
      for (let j = i; j < end; j++) rules[j] = 'excursion';
      done = end - 1;
      back = end;
      i = end;
    } else if (start >= 0) {
      for (let j = start; j < i; j++) rules[j] = 'excursion';
      done = i - 1;
      back = i;
    } else if (!fast(i - 1) && !fast(i + 1)) {
      rules[i] = 'jump';
    }
  }

  const judged: (TrackRule | null)[] = stale.map((isStale) => isStale ? 'excursion' : null);
  kept.forEach((index, i) => judged[index] = rules[i]);
  return judged;
}
