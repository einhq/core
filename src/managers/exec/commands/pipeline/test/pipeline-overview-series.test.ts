/**
 * pipeline-overview's completions series and per-pipeline rates, from the sampler's cumulative
 * `pipelines` counts.
 */

import { assertEquals } from '@std/assert';
import { completionGrowth } from '../pipeline-overview.ts';
import type { PipelinesEntry, Sample } from '../../../../../lib/metrics/mod.ts';

const BUCKET_MS = 1_000_000;
const MINUTE = 60_000;
const now = Date.now();
const start = Math.floor(now / BUCKET_MS) * BUCKET_MS - 10 * BUCKET_MS;
const sample = (bucket: number, completed: Record<string, number>): Sample<PipelinesEntry> => ({ at: start + bucket * BUCKET_MS, value: { completed } });
const total = (samples: Sample<PipelinesEntry>[]) => completionGrowth(samples, now).completions.reduce((sum, bucket) => sum + bucket.count, 0);

Deno.test("the first sample is a baseline, later growth lands in its sample's bucket", () => {
  const { completions } = completionGrowth([sample(0, { a: 100 }), sample(1, { a: 103 }), sample(1, { a: 105 }), sample(3, { a: 106 })], now);
  assertEquals(completions, [{ at: start + BUCKET_MS, count: 5 }, { at: start + 3 * BUCKET_MS, count: 1 }]);
});

Deno.test('the dip while a pruned page is unbanked is not counted as growth when it comes back', () => {
  // 10 completions, a page of 50 removed and then banked while 4 more complete, then 6 more.
  assertEquals(total([sample(0, { a: 100 }), sample(1, { a: 110 }), sample(2, { a: 62 }), sample(3, { a: 114 }), sample(4, { a: 120 })]), 20);
});

Deno.test('a pipeline is its own baseline when it first appears', () => {
  assertEquals(total([sample(0, { a: 100 }), sample(1, { a: 100, b: 3 }), sample(2, { a: 100, b: 5 })]), 2);
});

Deno.test('the rate is the growth over the hour, against the span of samples in it', () => {
  const at = (minutesAgo: number, completed: Record<string, number>): Sample<PipelinesEntry> => ({ at: now - minutesAgo * MINUTE, value: { completed } });
  const { perHour } = completionGrowth([at(90, { a: 0, b: 7 }), at(30, { a: 10, b: 7 }), at(20, { a: 15, b: 7 }), at(15, { a: 5, b: 7 }), at(0, { a: 20, b: 7 })], now);
  // Growth before the first sample in the hour is not in its span; the dip to 5 is no reset.
  assertEquals(perHour.get('a'), 20);
  assertEquals(perHour.get('b'), 0);
});
