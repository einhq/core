/**
 * health — is the system fine and keeping up: one verdict, and the checks it comes from.
 *
 * Core's checks are about the work, and warn only of what a person should look at. Every kind of
 * every work pool with something waiting says whether it drains, waits for EMS, waits behind other
 * work, or has no worker at all; it warns when EMS has turned it away for long, or when it waits
 * while the workers that take it are idle. What EMS answered is `pool-stat`'s, not a check's.
 * Failed pipeline work is either being run again on its own
 * (`pipeline heal`) or needs a person; input nothing can process is counted apart, since nothing
 * will ever change it. Running steps that have gone quiet and queue entries dropped after their
 * delivery attempts are listed too. A module adds checks of its own through a service's
 * `checkCommand` (ems: whether EMS answers, what it is degraded in, the card), asked while that
 * service runs.
 *
 * Everything here is a count or a bounded query — `pool-stat`, `pipeline-overview` and two
 * aggregates — so the dashboard and `top` poll it.
 */

import type { Gauge, HealthAnswer, HealthCheck, PoolKindThroughput, PoolStatAnswer, PoolWorkerInfo } from '../../../../lib/api/system.ts';
import type { PipelineOverview } from '../../../../lib/api/pipeline.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { readPipelineOverview } from '../pipeline/pipeline-overview.ts';
import { statAllPools } from '../pool/pool-stat.ts';
import { askService } from '../service/service-list.ts';
import { TEMPORARY_PAUSE_MAX_MS } from '../../../pipeline/pool-worker.ts';
import { fmtAge, fmtEta, HOUR, MINUTE } from './lib.ts';

/** How long the oldest job of a kind may wait, with none of it done and its workers idle, before it is a warning. */
const STALLED_AFTER_MS = HOUR;

/**
 * How long after the last step of a kind EMS turned away the kind still waits for EMS: a turned
 * away job is tried again after its own pause, which is at most `TEMPORARY_PAUSE_MAX_MS`. A refusal
 * older than that is not what the kind waits on now.
 */
const REFUSAL_CURRENT_MS = TEMPORARY_PAUSE_MAX_MS + MINUTE;

/** How long EMS may turn a kind away, with none of it done, before that is a warning and not a pause that ends. */
const UNAVAILABLE_WARN_MS = 30 * MINUTE;

/** How many quiet steps a check names; the rest are counted. */
const QUIET_NAMED = 3;

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

/** Failed instances a person has been asked to look at, and steps whose input nothing can process. */
export type Attention = { needsPerson: number; input: number };

export const readAttention = async (cmd: Command): Promise<Attention> => {
  const count = async (where: Parameters<Command['sys']['vfs']['aggregate']>[1]['where']) =>
    (await cmd.sys.vfs.aggregate(cmd.access, { where, group: [{ ref: 'status' }] })).reduce((sum, bucket) => sum + bucket.count, 0);
  const [needsPerson, input] = await Promise.all([
    count([{ ref: 'pipelineName', op: 'exists' }, { ref: 'status', op: 'eq', value: 'failed' }, { ref: 'needsPerson', op: 'exists' }]),
    count([{ ref: 'stepName', op: 'exists' }, { ref: 'cause', op: 'eq', value: 'input' }]),
  ]);
  return { needsPerson, input };
};

const isCheck = (value: unknown): value is HealthCheck => {
  const check = value as HealthCheck;
  return typeof check?.name === 'string' && typeof check.reason === 'string' && ['ok', 'warn', 'fail'].includes(check.state);
};

const isGauge = (value: unknown): value is Gauge => {
  const gauge = value as Gauge;
  return typeof gauge?.label === 'string' && typeof gauge.value === 'string' && (gauge.percent === undefined || typeof gauge.percent === 'number');
};

/** Ask every running service that declares `field` for its JSON answer, in parallel. */
const askServices = async (cmd: Command, field: 'checkCommand' | 'gaugeCommand'): Promise<{ service: string; answer: unknown[] | null }[]> => {
  const services = (await cmd.sys.serviceManager?.list() ?? []).filter((service) => service[field] && service.status === 'running');
  return await Promise.all(services.map(async (service) => {
    const stdout = await askService(cmd, service[field]!, true);
    try {
      const answer = stdout === null ? null : JSON.parse(stdout);
      return { service: service.name, answer: Array.isArray(answer) ? answer : null };
    } catch {
      return { service: service.name, answer: null };
    }
  }));
};

/** The checks running services answer about what they watch. One that does not answer is a warning against the service. */
export const serviceChecks = async (cmd: Command): Promise<HealthCheck[]> =>
  (await askServices(cmd, 'checkCommand')).flatMap(({ service, answer }) =>
    answer === null
      ? [{ name: service, state: 'warn' as const, reason: 'its check did not answer', service }]
      : answer.filter(isCheck).map((check) => ({ name: check.name, state: check.state, reason: check.reason, service }))
  );

/** The gauges running services draw beside the host's: ems's card memory, say. */
export const readGauges = async (cmd: Command): Promise<Gauge[]> =>
  (await askServices(cmd, 'gaugeCommand')).flatMap(({ service, answer }) => (answer ?? []).filter(isGauge).map((gauge) => ({ ...gauge, service })));

type Backlog = { checks: HealthCheck[]; waiting: number; draining: boolean; slowestEtaMs?: number };

/** Whether a worker is on other work: running jobs, holding room for a reserved kind, or on another kind's turn. */
const busyElsewhere = (worker: PoolWorkerInfo, kind: string): boolean =>
  Object.values(worker.running).some((count) => count > 0) || worker.accumulatingFor !== undefined ||
  (worker.currentKind !== undefined && worker.currentKind !== kind);

/** What one kind with something waiting says, in words a person can act on or leave be. */
const kindCheck = (kind: PoolKindThroughput, workers: PoolWorkerInfo[], now: number): Pick<HealthCheck, 'state' | 'reason'> => {
  const left = (kind.ready + kind.claimed).toLocaleString('en');
  const waited = kind.oldestReadyAt !== undefined ? `, the oldest for ${fmtAge(now - kind.oldestReadyAt)}` : '';

  if (kind.unservableSince !== undefined) return { state: 'fail', reason: `${left} waiting, and no worker offers this kind${waited}` };
  if (kind.perHour) return { state: 'ok', reason: `${left} left, ${kind.perHour}/h${fmtEta(kind.etaMs)}` };

  const refusal = kind.refusal && now - kind.refusal.at <= REFUSAL_CURRENT_MS ? kind.refusal : undefined;
  if (refusal && now - refusal.since >= UNAVAILABLE_WARN_MS) {
    return {
      state: 'warn',
      reason: `${left} waiting: EMS has not been able to run it for ${fmtAge(now - refusal.since)}. See EMS on the Services tab; the Work tab shows what it answered`,
    };
  }
  if (refusal || kind.restingUntil !== undefined) {
    const next = kind.restingUntil !== undefined ? ` in ${fmtAge(kind.restingUntil - now)}` : '';
    return { state: 'ok', reason: `${left} waiting: EMS could not run it just now, and it is tried again on its own${next}` };
  }
  if (kind.claimed > 0) return { state: 'ok', reason: `${left} waiting${waited}` };

  const offering = workers.filter((worker) => worker.kinds.length === 0 || worker.kinds.includes(kind.kind));
  if (offering.some((worker) => busyElsewhere(worker, kind.kind))) return { state: 'ok', reason: `${left} waiting behind other work${waited}` };
  if (offering.length > 0 && kind.oldestReadyAt !== undefined && now - kind.oldestReadyAt > STALLED_AFTER_MS) {
    return { state: 'warn', reason: `${left} waiting${waited}, and the workers that take it are idle: EiN is not handing it out. The Log tab may say why` };
  }
  return { state: 'ok', reason: `${left} waiting${waited}` };
};

/** One check per kind with something waiting, and what the verdict needs to know about all of them. */
const poolChecks = (pools: PoolStatAnswer[], now: number): Backlog => {
  const backlog: Backlog = { checks: [], waiting: 0, draining: false };

  for (const pool of pools) {
    if (pool.role === 'intake') {
      const left = pool.ready + pool.claimed;
      if (left === 0) continue;
      backlog.waiting += left;
      if (pool.perHour) backlog.draining = true;
      backlog.checks.push({ name: 'intake', state: 'ok', reason: `${plural(left, 'matched trigger')} waiting to start pipeline work` });
      continue;
    }

    for (const kind of pool.kinds ?? []) {
      const left = kind.ready + kind.claimed;
      if (left === 0) continue;
      backlog.waiting += left;
      if (kind.perHour && kind.unservableSince === undefined) {
        backlog.draining = true;
        if (kind.etaMs !== undefined) backlog.slowestEtaMs = Math.max(backlog.slowestEtaMs ?? 0, kind.etaMs);
      }
      backlog.checks.push({ name: `kind ${kind.kind}`, ...kindCheck(kind, pool.workers, now) });
    }
  }

  return backlog;
};

/** Failed work, quiet steps and dropped queue entries. */
const workChecks = (work: PipelineOverview, attention: Attention): HealthCheck[] => {
  const checks: HealthCheck[] = [];

  if (attention.needsPerson > 0) {
    checks.push({
      name: 'failed work',
      state: 'fail',
      reason: `${plural(attention.needsPerson, 'instance')} failed again after three more runs and need a person (pipeline-instances --status failed)`,
    });
  }
  const healing = work.instances.byStatus.failed - attention.needsPerson;
  if (healing > 0) {
    checks.push({ name: 'failed work', state: 'warn', reason: `${plural(healing, 'failed instance')}, run again on their own after 1 h, 6 h and 24 h` });
  }
  if (attention.input > 0) {
    checks.push({ name: 'input', state: 'ok', reason: `${plural(attention.input, 'step')} met input nothing can process, and will not be run again` });
  }

  if (work.quiet.length > 0) {
    const named = work.quiet.slice(0, QUIET_NAMED).map((step) => `${step.pipeline}/${step.step}`).join(', ');
    const more = work.quiet.length > QUIET_NAMED ? ` and ${work.quiet.length - QUIET_NAMED} more` : '';
    checks.push({ name: 'quiet steps', state: 'warn', reason: `${plural(work.quiet.length, 'running step')} silent for ${fmtAge(work.quietMs)} or more: ${named}${more}` });
  }

  for (const queue of work.queues) {
    if (queue.deadLettered > 0) {
      checks.push({
        name: `queue ${queue.name}`,
        state: 'fail',
        reason: `${plural(queue.deadLettered, 'entry', 'entries')} dropped after their delivery attempts (queue-dead ${queue.path}: --retry or --drop)`,
      });
    }
  }

  return checks;
};

/** Whether any pipeline instance finished in the last hour: inline work drains outside every pool. */
const finishedLastHour = (work: PipelineOverview, now: number): boolean => work.completions.some((bucket) => bucket.at >= now - HOUR && bucket.count > 0);

/** The verdict, in a word and in a sentence. */
const verdictOf = (checks: HealthCheck[], backlog: Backlog, drained: boolean): Pick<HealthAnswer, 'verdict' | 'summary'> => {
  const failed = checks.filter((check) => check.state === 'fail').length;
  if (failed > 0) return { verdict: 'needs-person', summary: `needs a person: ${plural(failed, 'check')} failed` };
  if (backlog.waiting === 0) return { verdict: 'healthy', summary: `healthy: nothing waiting` };
  if (backlog.draining || drained) {
    const eta = backlog.slowestEtaMs !== undefined ? `, the slowest kind done in ${fmtAge(backlog.slowestEtaMs)}` : '';
    return { verdict: 'catching-up', summary: `catching up: ${plural(backlog.waiting, 'job')} waiting${eta}` };
  }
  return { verdict: 'stuck', summary: `stuck: ${plural(backlog.waiting, 'job')} waiting, none done in the last hour` };
};

/** What a verdict is made from; `top` holds most of it already and reads only the rest. */
type HealthInputs = { pools: PoolStatAnswer[]; work: PipelineOverview; attention: Attention; services: HealthCheck[] };

/** The verdict and the checks, from what was read. */
export const assessHealth = ({ pools, work, attention, services }: HealthInputs, now = Date.now()): HealthAnswer => {
  const backlog = poolChecks(pools, now);
  const checks = [...services, ...backlog.checks, ...workChecks(work, attention)];
  return { ...verdictOf(checks, backlog, finishedLastHour(work, now)), checks };
};

/** The health of the system as `health` answers it. */
const readHealth = async (cmd: Command): Promise<HealthAnswer> => {
  const [pools, work, attention, services] = await Promise.all([statAllPools(cmd), readPipelineOverview(cmd), readAttention(cmd), serviceChecks(cmd)]);
  return assessHealth({ pools, work, attention, services });
};

const STATE_ORDER = { fail: 0, warn: 1, ok: 2 } as const;

export const health = async (cmd: Command): CmdReturn => {
  const answer = await readHealth(cmd);
  if (cmd.json) {
    await cmd.writeJSON(answer satisfies HealthAnswer);
    return 0;
  }

  await cmd.writeLn(answer.summary);
  const width = Math.max(0, ...answer.checks.map((check) => check.name.length));
  for (const check of [...answer.checks].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state])) {
    await cmd.writeLn(`${check.state.padEnd(5)} ${check.name.padEnd(width)}  ${check.reason}`);
  }
  return 0;
};

health.spec = {
  name: 'health',
  effect: 'read' as const,
  description: 'Say whether the system is healthy, catching up, stuck or needs a person, and the checks that decide it',
  args: [],
};

export const gauges = async (cmd: Command): CmdReturn => {
  const answer = await readGauges(cmd);
  if (cmd.json) {
    await cmd.writeJSON(answer satisfies Gauge[]);
    return 0;
  }
  for (const gauge of answer) {
    await cmd.writeLn(`${gauge.label.padEnd(16)} ${gauge.percent !== undefined ? `${String(Math.round(gauge.percent)).padStart(3)}%  ` : ''}${gauge.value}`);
  }
  return 0;
};

gauges.spec = {
  name: 'gauges',
  effect: 'read' as const,
  description: "List the gauges running services draw beside the host's (a card's memory, say)",
  args: [],
};
