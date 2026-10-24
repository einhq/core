/**
 * `health`'s verdict from what was read: nothing waiting, work draining, work that does not, a
 * check a person has to act on — and work waiting for hardware this host lacks, which is none of
 * these.
 */

import { assertEquals } from '@std/assert';
import type { PipelineOverview } from '../../../../../lib/api/pipeline.ts';
import type { PoolKindThroughput, PoolStatAnswer } from '../../../../../lib/api/system.ts';
import { assessHealth } from '../health.ts';

const NOW = Date.UTC(2026, 9, 10, 12);
const HOUR = 3_600_000;

const kind = (name: string, fields: Partial<PoolKindThroughput>): PoolKindThroughput => ({ kind: name, ready: 0, claimed: 0, done: 0, failed: 0, ...fields });

const pool = (kinds: PoolKindThroughput[]): PoolStatAnswer => ({
  name: 'media',
  path: '/var/pools/media',
  role: 'work',
  ready: kinds.reduce((sum, k) => sum + k.ready, 0),
  claimed: 0,
  done: 0,
  failed: 0,
  kinds,
  workers: [],
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
    assertEquals(answer.checks, [{ name: 'kind faces', state: 'warn', reason: '40 waiting, the oldest for 3h00m, none done in the last hour' }]);
  });

  await t.step('a kind resting because EMS could not run it says when it is tried again', () => {
    const pools = [pool([kind('faces', { ready: 40, restingUntil: NOW + 90_000 })])];
    const answer = assessHealth({ pools, work: work({ completedLastHour: 12 }), attention: calm, services: [] }, NOW);
    // Instances finished in the last hour: the engine drains, if this kind does not.
    assertEquals(answer.verdict, 'catching-up');
    assertEquals(answer.checks[0].reason, '40 waiting for EMS, which could not run it yet; next try in 1m30s');
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
