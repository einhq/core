/**
 * The rules a track's fixes go through: what is an excursion, what is a jump,
 * and what is neither.
 */

import { assertEquals } from '@std/assert';
import { judgeFixes, type RuleFix } from '../rules.ts';

const BASE = Date.parse('2015-07-04T10:00:00.000Z');

/** `count` fixes `stepMs` apart from `startMs`, drifting east from `lat`,`lng` by `stepDeg` a fix. */
const drive = (startMs: number, count: number, lat: number, lng: number, stepMs = 1000, stepDeg = 0.0001): RuleFix[] =>
  Array.from({ length: count }, (_, i) => ({ ms: startMs + i * stepMs, lat, lng: lng + i * stepDeg }));

/** The rule of each fix, as one string: `.` accepted, `x` excursion, `j` jump. */
const verdicts = (fixes: RuleFix[]): string => judgeFixes(fixes).map((rule) => rule === 'excursion' ? 'x' : rule === 'jump' ? 'j' : '.').join('');

Deno.test('a steady track is accepted', () => {
  assertEquals(verdicts(drive(BASE, 20, 57.7, 11.9)), '.'.repeat(20));
});

Deno.test('a run the track jumps out to and back from is an excursion', () => {
  const fixes = [
    ...drive(BASE, 5, 57.7, 11.9),
    // Two degrees north in five seconds, a smooth run there, and back.
    ...drive(BASE + 10_000, 4, 59.7, 12.3),
    ...drive(BASE + 20_000, 5, 57.7, 11.9005),
  ];

  assertEquals(verdicts(fixes), '.....xxxx.....');
});

Deno.test('a run entered without hurry and left by a jump is an excursion when it is the shorter', () => {
  const fixes = [
    ...drive(BASE, 30, 57.7, 11.9),
    // Two kilometres north over two minutes is possible; back in six seconds is not.
    ...drive(BASE + 150_000, 3, 57.718, 11.9),
    ...drive(BASE + 156_000, 30, 57.7, 11.903),
  ];

  assertEquals(verdicts(fixes), '.'.repeat(30) + 'xxx' + '.'.repeat(30));
});

Deno.test('a position the track falls back to at the last decimal is an excursion', () => {
  const fallback = { lat: 57.712345, lng: 11.912345 };
  const fixes = [
    ...drive(BASE, 5, 57.7, 11.9),
    { ms: BASE + 60_000, ...fallback },
    ...drive(BASE + 70_000, 5, 57.7, 11.9005),
    // Back on it two minutes later, slowly enough that the step alone is no jump, and held.
    { ms: BASE + 200_000, ...fallback },
    { ms: BASE + 205_000, ...fallback },
    ...drive(BASE + 400_000, 5, 57.7, 11.901),
  ];

  // The first visit is a slow leap out and back, which the read's spike filter is for.
  assertEquals(verdicts(fixes), '.....' + '.' + '.....' + 'xx' + '.....');
});

Deno.test('a jump that does not come back cuts the line and keeps the fixes', () => {
  const fixes = [
    ...drive(BASE, 5, 57.7, 11.9),
    // Fifteen kilometres in ten seconds, then steady going there.
    ...drive(BASE + 14_000, 5, 57.835, 11.9),
  ];

  assertEquals(verdicts(fixes), '.....j....');
});

Deno.test('a jump over a pause is neither', () => {
  const fixes = [
    ...drive(BASE, 5, 57.7, 11.9),
    ...drive(BASE + 3_600_000, 5, 59.7, 12.3),
    ...drive(BASE + 7_200_000, 5, 57.7, 11.9),
  ];

  assertEquals(verdicts(fixes), '.'.repeat(15));
});

Deno.test('a run that stays away longer than an excursion lasts is no excursion', () => {
  const fixes = [
    ...drive(BASE, 5, 57.7, 11.9),
    ...drive(BASE + 10_000, 4, 59.7, 12.3, 3_600_000),
    ...drive(BASE + 10_000 + 3 * 3_600_000 + 5_000, 5, 57.7, 11.9),
  ];

  // Out and back are jumps with steady going around them, and nothing pairs them.
  assertEquals(verdicts(fixes), '.....j...' + 'j....');
});

Deno.test('an aircraft is neither', () => {
  // 250 m/s, a fix every ten seconds: every step is fast, none stands out.
  const flight = drive(BASE, 60, 57.7, 11.9, 10_000, 0.042);
  assertEquals(verdicts(flight), '.'.repeat(60));
});

Deno.test('a run of fixes on a road is not a fallback where the road passes a point twice', () => {
  // Out along a road and back the same way: the fixes coincide but no leap lands on them.
  const out = drive(BASE, 20, 57.7, 11.9, 1000, 0.0003);
  const back = out.map((_, i) => ({ ...out[out.length - 1 - i], ms: BASE + 30_000 + i * 1000 }));
  assertEquals(verdicts([...out, ...back]), '.'.repeat(40));
});

Deno.test('coming back from a spike to where the track lay, to the last decimal, is no fallback', () => {
  // A low-precision logger lying still repeats its position exactly; one fix thrown 3 km off.
  const still = (i: number): RuleFix => ({ ms: BASE + i * 60_000, lat: 57.7 + (i % 3) * 0.0001, lng: 11.9 });
  const fixes = Array.from({ length: 31 }, (_, i) => i === 15 ? { ms: BASE + i * 60_000, lat: 57.727, lng: 11.9 } : still(i));
  assertEquals(verdicts(fixes), '.'.repeat(31));
});
