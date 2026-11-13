/**
 * `health`'s verdict from what was read: nothing waiting, work draining, work that does not, a
 * check a person has to act on — and work waiting for hardware this host lacks, which is none of
 * these.
 */

import { assertEquals } from '@std/assert';
import type { PipelineOverview } from '../../../../../lib/api/pipeline.ts';
import type { PoolKindThroughput, PoolStatAnswer, PoolWorkerInfo } from '../../../../../lib/api/system.ts';
import { assessHealth } from '../health.ts';

const NOW = Date.UTC(2026, 9, 10, 12);
const HOUR = 3_600_000;

const kind = (name: string, fields: Partial<PoolKindThroughput>): PoolKindThroughput => ({ kind: name, ready: 0, claimed: 0, done: 0, failed: 0, ...fields });

const worker = (fields: Partial<PoolWorkerInfo> = {}): PoolWorkerInfo => ({
  name: 'models',
  kinds: ['faces', 'transcribe'],
  kindQuantumMs: HOUR,
  concurrency: 1,
  capacity: {},
  inUse: {},
  running: {},
  reserveKinds: [],
  reserveCapacity: {},
  resting: {},
  refused: {},
  ...fields,
});

const pool = (kinds: PoolKindThroughput[], workers: PoolWorkerInfo[] = []): PoolStatAnswer => ({
  name: 'media',
  path: '/var/pools/media',
  role: 'work',
  ready: kinds.reduce((sum, k) => sum + k.ready, 0),
  claimed: 0,
  done: 0,
  failed: 0,
  kinds,
  workers,
  backlog: 0,
  counts: { ready: 0, claimed: 0, done: 0, failed: 0, cancelled: 0, total: 0 },
  policy: { agingSeconds: 0, agingBoost: 0, agingMax: 0, leaseMs: 0, maxAttempts: 3, backoffMs: 0, backoffMaxMs: 0, sweepIntervalMs: 0 },
});

const work = (fields: { failed?: number; completedLastHour?: number } = {}): PipelineOverview => ({
  instances: { total: 0, byStatus: { running: 0, queued: 0, completed: 0, failed: fields.failed ?? 0, cancelled: 0 }, byPipeline: [] },
  steps: { byStatus: {} },
  queues: [],
  active: [],
  quiet: [],
  quietMs: 30 * 60_000,
  completions: fields.completedLastHour ? [{ at: NOW - 10 * 60_000, count: fields.completedLastHour }] : [],
} as unknown as PipelineOverview);

const calm = { needsPerson: 0, input: 0 };

Deno.test('health', async (t) => {
  await t.step('nothing waiting is healthy', () => {
    const answer = assessHealth({ pools: [pool([])], work: work(), attention: calm, services: [] }, NOW);
    assertEquals([answer.verdict, answer.summary], ['healthy', 'healthy: nothing waiting']);
  });

  await t.step('work waiting and draining is catching up, with the slowest kind', () => {
    const pools = [pool([kind('faces', { ready: 300, perHour: 600, etaMs: HOUR / 2 }), kind('transcribe', { ready: 1200, perHour: 300, etaMs: 4 * HOUR })])];
    const answer = assessHealth({ pools, work: work(), attention: calm, services: [] }, NOW);
    assertEquals(answer.verdict, 'catching-up');
    assertEquals(answer.summary, 'catching up: 1,500 jobs waiting, the slowest kind done in 4h00m');
  });

  await t.step('work waiting that nothing finishes is stuck, and the kind says how long it has waited', () => {
    const pools = [pool([kind('faces', { ready: 40, oldestReadyAt: NOW - 3 * HOUR })])];
    const answer = assessHealth({ pools, work: work(), attention: calm, services: [] }, NOW);
    assertEquals(answer.verdict, 'stuck');
    assertEquals(answer.checks, [{ name: 'kind faces', state: 'ok', reason: '40 waiting, the oldest for 3h00m' }]);
  });

  await t.step('a kind waiting behind other work is fine, however long it has waited', () => {
    const onOcr = worker({ kinds: ['faces', 'ocr'], currentKind: 'ocr', running: { ocr: 2 } });
    const pools = [pool([kind('faces', { ready: 677, oldestReadyAt: NOW - 3 * HOUR })], [onOcr])];
    const answer = assessHealth({ pools, work: work(), attention: calm, services: [] }, NOW);
    assertEquals(answer.checks, [{ name: 'kind faces', state: 'ok', reason: '677 waiting behind other work, the oldest for 3h00m' }]);
  });

  await t.step('a kind waiting for an hour while the workers that take it are idle is a warning', () => {
    const pools = [pool([kind('faces', { ready: 40, oldestReadyAt: NOW - 2 * HOUR })], [worker()])];
    const answer = assessHealth({ pools, work: work(), attention: calm, services: [] }, NOW);
    assertEquals(answer.checks, [{
      name: 'kind faces',
      state: 'warn',
      reason: '40 waiting, the oldest for 2h00m, and the workers that take it are idle: EiN is not handing it out. The Log tab may say why',
    }]);
  });

  await t.step('a kind EMS turned away just now is fine, and says when it is tried again', () => {
    const refusal = {
      at: NOW - 60_000,
      since: NOW - 5 * 60_000,
      reason: 'detect-faces: ems: faces.detect model worker is not answering (ConnectionRefusedError) (model_unavailable)',
    };
    const resting = assessHealth({
      pools: [pool([kind('faces', { ready: 40, restingUntil: NOW + 90_000, refusal })])],
      work: work({ completedLastHour: 12 }),
      attention: calm,
      services: [],
    }, NOW);
    // Instances finished in the last hour: the engine drains, if this kind does not.
    assertEquals(resting.verdict, 'catching-up');
    assertEquals(resting.checks, [{ name: 'kind faces', state: 'ok', reason: '40 waiting: EMS could not run it just now, and it is tried again on its own in 1m30s' }]);
    const handedBack = assessHealth({ pools: [pool([kind('faces', { ready: 40, refusal })], [worker()])], work: work(), attention: calm, services: [] }, NOW);
    assertEquals(handedBack.checks[0].reason, '40 waiting: EMS could not run it just now, and it is tried again on its own');
  });

  await t.step('a kind EMS has turned away for half an hour is a warning that says where to look', () => {
    const refusal = {
      at: NOW - 60_000,
      since: NOW - 42 * 60_000,
      reason: 'detect-faces: ems: faces.detect model worker is not answering (ConnectionRefusedError) (model_unavailable)',
    };
    const answer = assessHealth({ pools: [pool([kind('faces', { ready: 40, restingUntil: NOW + 90_000, refusal })])], work: work(), attention: calm, services: [] }, NOW);
    assertEquals(answer.checks, [{
      name: 'kind faces',
      state: 'warn',
      reason: '40 waiting: EMS has not been able to run it for 42m00s. See EMS on the Services tab; the Work tab shows what it answered',
    }]);
  });

  await t.step('a refusal older than the longest pause is not what the kind waits on', () => {
    const refusal = {
      at: NOW - 31 * 60_000,
      since: NOW - 35 * 60_000,
      reason: 'detect-faces: ems: faces.detect model worker is not answering (ConnectionRefusedError) (model_unavailable)',
    };
    const onOcr = worker({ kinds: ['faces', 'ocr'], currentKind: 'ocr', running: { ocr: 1 } });
    const answer = assessHealth({
      pools: [pool([kind('faces', { ready: 677, oldestReadyAt: NOW - 3 * HOUR, refusal })], [onOcr])],
      work: work(),
      attention: calm,
      services: [],
    }, NOW);
    assertEquals(answer.checks, [{ name: 'kind faces', state: 'ok', reason: '677 waiting behind other work, the oldest for 3h00m' }]);
  });

  await t.step('failed work that runs again on its own is a warning; work for a person fails', () => {
    const answer = assessHealth({ pools: [], work: work({ failed: 5 }), attention: { needsPerson: 2, input: 7 }, services: [] }, NOW);
    assertEquals(answer.verdict, 'needs-person');
    assertEquals(answer.checks.map((check) => [check.name, check.state]), [['failed work', 'fail'], ['failed work', 'warn'], ['input', 'ok']]);
    assertEquals(answer.checks[1].reason, '3 failed instances, run again on their own after 1 h, 6 h and 24 h');
  });

  await t.step("a service's failed check needs a person, and leads the list", () => {
    const services = [{ name: 'ems gpu', state: 'fail' as const, reason: 'this host is meant to have a card, and none is visible', service: 'ems-link' }];
    const answer = assessHealth({ pools: [pool([kind('faces', { ready: 3, perHour: 60 })])], work: work(), attention: calm, services }, NOW);
    assertEquals([answer.verdict, answer.summary], ['needs-person', 'needs a person: 1 check failed']);
    assertEquals(answer.checks[0].service, 'ems-link');
  });
});
