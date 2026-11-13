/**
 * A pool kind waits for EMS only while every worker that offers it rests it: a worker for a second
 * instance resting a kind the primary's worker still takes is no wait.
 */

import { assertEquals } from '@std/assert';
import { kindRefusal, kindRest } from '../pool-stat.ts';

const worker = (name: string, kinds: string[], resting: Record<string, number> = {}) => ({
  name,
  kinds,
  resting: Object.fromEntries(Object.entries(resting).map(([kind, until]) => [kind, { until }])),
});

Deno.test('a kind rests only while every worker offering it rests it, until the first tries again', () => {
  const models = worker('models', ['faces', 'ocr'], { ocr: 2_000 });
  const laptop = worker('models@laptop', ['faces'], { faces: 1_000 });
  assertEquals(kindRest([models, laptop], 'faces'), {});
  assertEquals(kindRest([models, laptop], 'ocr'), { restingUntil: 2_000, restingIn: ['models'] });
  const both = [worker('models', ['faces'], { faces: 3_000 }), laptop];
  assertEquals(kindRest(both, 'faces'), { restingUntil: 1_000, restingIn: ['models', 'models@laptop'] });
  assertEquals(kindRest([], 'faces'), {});
  // A worker with no kinds offers every kind.
  assertEquals(kindRest([worker('any', []), laptop], 'faces'), {});
});

Deno.test("a kind's refusal is the newest among the workers that offer it", () => {
  const refused = (kinds: string[], refusals: Record<string, number>) => ({
    kinds,
    refused: Object.fromEntries(Object.entries(refusals).map(([kind, at]) => [kind, { at, since: at, reason: `at ${at}` }])),
  });
  const models = refused(['faces', 'ocr'], { ocr: 2_000, faces: 500 });
  const laptop = refused(['faces'], { faces: 1_000 });
  assertEquals(kindRefusal([models, laptop], 'faces'), { refusal: { at: 1_000, since: 1_000, reason: 'at 1000' } });
  assertEquals(kindRefusal([models, laptop], 'ocr'), { refusal: { at: 2_000, since: 2_000, reason: 'at 2000' } });
  assertEquals(kindRefusal([laptop], 'ocr'), {});
});
