/**
 * What a `waiting` step waits on when its service is down (ein/core#1584): `pipeline overview`
 * names the pool kinds whose steps could not run, and `pipeline status` the reason of each step.
 */

import { assertEquals } from '@std/assert';
import { heldOn } from '../pipeline-overview.ts';
import { stepWhy } from '../pipeline-status.ts';
import type { PoolCounts } from '../../../../../registries/pool/mod.ts';

const counts = (ready: number, claimed = 0): PoolCounts => ({ ready, claimed, done: 0, failed: 0, cancelled: 0, total: ready + claimed });

const refusal = (at: number, reason = 'ems: media.probe unreachable: connection refused') => ({ at, since: at - 60_000, reason });

Deno.test('a kind is held while its workers refused it and jobs of it are left', () => {
  const cpu = { name: 'media-worker', kinds: ['ingest', 'stills'], resting: { ingest: { until: 9_000 } }, refused: { ingest: refusal(5_000) } };
  const models = { name: 'models', kinds: ['ocr'], resting: {}, refused: { ocr: refusal(4_000, 'ems: ocr.read unreachable') } };
  const held = heldOn('media', [cpu, models], { ingest: counts(198, 2), stills: counts(40), ocr: counts(71) });
  assertEquals(held, [
    { pool: 'media', kind: 'ingest', waiting: 200, since: -55_000, at: 5_000, reason: 'ems: media.probe unreachable: connection refused', restingUntil: 9_000 },
    { pool: 'media', kind: 'ocr', waiting: 71, since: -56_000, at: 4_000, reason: 'ems: ocr.read unreachable' },
  ]);
});

Deno.test('a refusal of a kind with nothing left is about work that has gone', () => {
  const cpu = { kinds: ['ingest'], resting: {}, refused: { ingest: refusal(5_000) } };
  assertEquals(heldOn('media', [cpu], { ingest: counts(0) }), []);
  assertEquals(heldOn('media', [cpu], {}), []);
  assertEquals(heldOn('media', [{ kinds: ['ingest'], resting: {}, refused: {} }], { ingest: counts(3) }), []);
});

Deno.test('a waiting step says what it could not run for, and a failed one why', () => {
  const now = 1_000_000;
  const error = 'exif-extract: +2ms asking ems\nexif-extract: ems: media.probe unreachable: connection refused';
  assertEquals(
    stepWhy({ status: 'waiting', exitCode: 75, error, waitingSince: now - 180_000 }, now),
    'waiting, could not run 3m00s ago: exif-extract: ems: media.probe unreachable: connection refused',
  );
  assertEquals(stepWhy({ status: 'waiting', exitCode: 1, error: 'boom' }, now), 'waiting, the last attempt failed: boom');
  assertEquals(stepWhy({ status: 'failed', exitCode: 1, error: 'boom' }, now), 'failed: boom');
  assertEquals(stepWhy({ status: 'waiting' }, now), undefined);
  assertEquals(stepWhy({ status: 'completed', exitCode: 75, error }, now), undefined);
});
