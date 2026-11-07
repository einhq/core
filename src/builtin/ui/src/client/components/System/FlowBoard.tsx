import { Badge, Box, Card, Group, Progress, Skeleton, Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';
import type { PoolKindThroughput, PoolStatAnswer, PoolWorkerInfo } from '@ein/api';
import type { PipelineRow } from '@ein/ui/hooks';
import { formatDuration } from '../../lib/format.ts';
import { WAITING_COLOR, WORKLOAD_COLORS } from '../Pipeline/palette.ts';
import { FlowArrow, FlowColumn, FlowGroupLabel, FlowItem, FlowSlots } from './Flow.tsx';

type Props = {
  rows: PipelineRow[];
  /** What each pipeline has not started yet, by name (the intake pool's lines). */
  notStarted: Record<string, number>;
  pools?: PoolStatAnswer[] | null;
  /** The columns after EiN's own: the `system.flow` panels (ems's lanes and models). */
  children?: ReactNode;
};

/** How many pipelines the Not started column names before it says how many more. */
const NAMED_PIPELINES = 6;

type Line = PoolKindThroughput & { pool: string; servers: PoolWorkerInfo[] };

const serves = (worker: PoolWorkerInfo, kind: string): boolean => worker.kinds.length === 0 || worker.kinds.includes(kind);

const workerName = (worker: PoolWorkerInfo): string => worker.name ?? 'worker';

/** What is left of a worker's turn on its line, or undefined when it does not take turns. */
const turnLeft = (worker: PoolWorkerInfo, now: number): number | undefined =>
  worker.kindQuantumMs > 0 && worker.currentKind !== undefined && worker.kindSince !== undefined ? Math.max(0, worker.kindQuantumMs - (now - worker.kindSince)) : undefined;

/** Why a line with work in it is not moving, or undefined when it is. */
const stillBecause = (line: Line, now: number): string | undefined => {
  if (line.ready === 0 || line.claimed > 0) return undefined;
  if (line.unservableSince !== undefined) return 'no worker serves it';
  if (line.restingUntil !== undefined) return `the media service could not run it; next try in ${formatDuration(line.restingUntil - now)}`;
  const busy = line.servers.find((worker) => worker.currentKind !== undefined && worker.currentKind !== line.kind && turnLeft(worker, now) !== undefined);
  if (busy) return `${workerName(busy)} is on ${busy.currentKind} for ${formatDuration(turnLeft(busy, now))} more, or until that line is empty`;
  return undefined;
};

/**
 * Where the work is, left to right in the order it moves: what EiN has noticed but not made yet
 * (Not started, by pipeline), what is made and stands in a line for a worker (In line, each line
 * under the workers that serve it, the one a worker is on now outlined), and the workers with their
 * slots and turns (Running in EiN). Then the `system.flow` panels a module adds — ems's lanes and
 * the models working — so the media service's side is part of the same picture. Under it, why a
 * line with work in it is not moving.
 *
 * Built from the dashboard's own polls (`pipeline-overview`, `pool-stat`); nothing of its own.
 */
export function FlowBoard({ rows, notStarted, pools, children }: Props) {
  const now = Date.now();
  const work = (pools ?? []).filter((pool) => pool.role === 'work');
  const workers = work.flatMap((pool) => pool.workers);

  const waiting = Object.entries(notStarted).filter(([, left]) => left > 0).sort((a, b) => b[1] - a[1]);
  const notStartedTotal = waiting.reduce((sum, [, left]) => sum + left, 0);
  const inLine = rows.reduce((sum, row) => sum + row.queued, 0);
  const running = rows.reduce((sum, row) => sum + row.running, 0);

  const lines: Line[] = work.flatMap((pool) =>
    (pool.kinds ?? [])
      .filter((kind) => kind.ready + kind.claimed > 0)
      .map((kind) => ({ ...kind, pool: pool.name, servers: pool.workers.filter((worker) => serves(worker, kind.kind)) }))
  );
  const pooled = lines.reduce((sum, line) => sum + line.ready, 0);
  // Lines grouped by the workers that serve them: `models · models-second` above theirs.
  const groups = new Map<string, Line[]>();
  for (const line of lines.sort((a, b) => b.ready - a.ready)) {
    const label = line.servers.length > 0 ? line.servers.map(workerName).join(' · ') : 'no worker';
    groups.set(label, [...(groups.get(label) ?? []), line]);
  }
  const answers = lines.flatMap((line) => {
    const why = stillBecause(line, now);
    return why ? [{ line: line.kind, ready: line.ready, why }] : [];
  });

  return (
    <Card>
      <Group gap='xs' mb='sm' align='baseline'>
        <Title order={4}>Where the work is</Title>
        <Text size='xs' c='dimmed'>from a change EiN noticed to the model working on it</Text>
      </Group>
      {!pools ? <Skeleton height={140} /> : (
        <Box style={{ overflowX: 'auto' }} pb={4}>
          <Group gap='sm' wrap='nowrap' align='flex-start' w='max-content'>
            <FlowColumn title='Not started' count={notStartedTotal} color={WAITING_COLOR} hint='Changes noticed, work not made yet, by pipeline.'>
              {waiting.slice(0, NAMED_PIPELINES).map(([pipeline, left]) => (
                <FlowItem key={pipeline}>
                  <Group gap='xs' wrap='nowrap'>
                    <Text size='sm' truncate style={{ flex: 1 }}>{pipeline}</Text>
                    <Text size='sm' fw={600}>{left.toLocaleString()}</Text>
                  </Group>
                </FlowItem>
              ))}
              {waiting.length > NAMED_PIPELINES && <Text size='xs' c='dimmed'>and {waiting.length - NAMED_PIPELINES} more pipelines</Text>}
              {waiting.length === 0 && <Text size='xs' c='dimmed'>Nothing</Text>}
            </FlowColumn>

            <FlowArrow />

            <FlowColumn title='In line' count={inLine} color={WORKLOAD_COLORS.queued} hint='Made, the next step waiting for a worker; one line per kind of step.'>
              {[...groups].map(([label, members]) => (
                <Stack key={label} gap={4}>
                  <FlowGroupLabel>for {label}</FlowGroupLabel>
                  {members.map((line) => {
                    const turn = line.servers.filter((worker) => worker.currentKind === line.kind);
                    const why = stillBecause(line, now);
                    return (
                      <FlowItem key={`${line.pool}/${line.kind}`} active={turn.length > 0}>
                        <Group gap='xs' wrap='nowrap'>
                          <Text size='sm' ff='monospace' style={{ flex: 1 }}>{line.kind}</Text>
                          <Text size='sm' fw={600}>{line.ready.toLocaleString()}</Text>
                        </Group>
                        <Text size='xs' c='dimmed'>
                          {turn.length > 0 ? `${turn.map(workerName).join(' and ')}'s turn` : why ?? (line.claimed > 0 ? `${line.claimed} running` : 'waits for a free slot')}
                        </Text>
                      </FlowItem>
                    );
                  })}
                </Stack>
              ))}
              {lines.length === 0 && <Text size='xs' c='dimmed'>No line has work</Text>}
              {inLine > pooled && <Text size='xs' c='dimmed'>{(inLine - pooled).toLocaleString()} wait for an earlier step of their own, in no line</Text>}
            </FlowColumn>

            <FlowArrow />

            <FlowColumn title='Running in EiN' count={running} color={WORKLOAD_COLORS.running} hint='The workers that take from the lines, and their slots.'>
              {workers.map((worker, index) => {
                const left = turnLeft(worker, now);
                const takes = Object.entries(worker.running);
                return (
                  <Box key={`${worker.name ?? 'worker'}-${index}`} p={8} style={{ borderRadius: 8, background: 'var(--mrx-surface-overlay)' }}>
                    <Group gap='xs' wrap='nowrap' mb={4}>
                      <Text size='sm' fw={600} style={{ flex: 1 }}>{workerName(worker)}</Text>
                      {Object.entries(worker.capacity).map(([key, total]) => (
                        <FlowSlots
                          key={key}
                          used={worker.inUse[key] ?? 0}
                          total={total}
                          reserved={0}
                          label={`${key}: ${worker.inUse[key] ?? 0} of ${total} in use`}
                        />
                      ))}
                    </Group>
                    {worker.currentKind && left !== undefined
                      ? (
                        <>
                          <Text size='xs' c='dimmed'>
                            on <Text span ff='monospace' size='xs'>{worker.currentKind}</Text>, {formatDuration(left)} of its turn left
                          </Text>
                          <Progress value={100 - (left / worker.kindQuantumMs) * 100} size={4} mt={4} color={WORKLOAD_COLORS.running} />
                        </>
                      )
                      : (
                        <Text size='xs' c='dimmed'>
                          {takes.length > 0 ? takes.map(([kind, n]) => `${kind} ${n}`).join(' · ') : 'nothing running'}
                        </Text>
                      )}
                    {worker.kinds.length > 0 && <Text size='xs' c='dimmed' mt={4} lineClamp={2}>serves {worker.kinds.join(', ')}</Text>}
                  </Box>
                );
              })}
              {workers.length === 0 && <Text size='xs' c='dimmed'>No worker runs in this EiN</Text>}
            </FlowColumn>

            {children}
          </Group>
        </Box>
      )}
      {answers.length > 0 && (
        <Stack gap={6} mt='md'>
          {answers.slice(0, 4).map((answer) => (
            <Group key={answer.line} gap='xs' wrap='nowrap' align='flex-start'>
              <Badge size='sm' variant='light' color='yellow' tt='none' style={{ flexShrink: 0 }}>{answer.ready.toLocaleString()} in line</Badge>
              <Text size='sm'>
                <Text span ff='monospace' size='sm'>{answer.line}</Text> is not moving: {answer.why}.
              </Text>
            </Group>
          ))}
        </Stack>
      )}
    </Card>
  );
}
