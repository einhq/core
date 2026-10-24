import { Box, Card, Group, Skeleton, Stack, Table, Text, Tooltip } from '@mantine/core';
import { IconTopologyRing } from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';
import type { PipelineTriggerSummary } from '@ein/api';
import type { PipelineRow } from '@ein/ui/hooks';
import { formatCount, formatDuration } from '../../lib/format.ts';
import { TriggerPopover } from './TriggerPopover.tsx';
import { WorkloadBar } from './WorkloadBar.tsx';
import { CANCELLED_COLOR, WAITING_COLOR, WORKLOAD_COLORS } from './palette.ts';

/** What is still waiting to become an instance of a pipeline, how fast it drains, and when. */
export type PipelineBacklog = {
  left: number;
  /** Finishing per hour — the rate `etaMs` divides by. */
  perHour?: number;
  /** Arriving per hour. Against `perHour` it says whether the backlog is draining or growing. */
  inPerHour?: number;
  etaMs?: number;
};

type Props = {
  rows: PipelineRow[];
  /** The instance counts are not in yet, so `rows` would be all zeroes: draws placeholder rows instead. */
  loading?: boolean;
  /**
   * The counts are in but `backlog` is not — it comes from a different command. Only the columns
   * it feeds are drawn as placeholders, since 0 waiting and no rate would read as an answer.
   */
  backlogLoading?: boolean;
  /**
   * Queue entries that failed every delivery attempt. Shown only when non-zero, because zero
   * is the normal state and a permanent `dead 0` is read past rather than read. This table is
   * the one place dropped work is visible at all.
   */
  deadLettered?: number;
  /**
   * Per pipeline, keyed by name. Comes from the intake pool's kinds — a matched trigger that
   * has not been turned into an instance yet — so it is work this pipeline has not started
   * rather than work it is doing.
   */
  backlog?: Record<string, PipelineBacklog>;
  /**
   * Pipeline name to its trigger alternatives, from `pipeline-list`.
   *
   * The consumer half of the relationship, which is the half that is declared: a pipeline
   * states what starts it, and nothing states what *produces* a fact — the archive bridge derives
   * those from node state, so `media-ingest` has no idea it is what leads to
   * `media.metadata.extracted`.
   */
  triggers?: Record<string, PipelineTriggerSummary[]>;
};

/**
 * One row per pipeline — bounded by the number of definitions, not by the
 * number of instances. This is the level at which "what is the system doing"
 * is actually answerable; individual instances live behind the drill-down.
 *
 * "Left" and "ETA" are the numbers that answer "when is this archive finished". They belong
 * here rather than in a card of their own because this table is already per pipeline — the
 * counts to the left are what a pipeline has done, and these are what it has not started. Split
 * across two cards, a total would read as "finished" while pipelines still had days of work
 * queued.
 */
export function PipelineMatrix({ rows, loading, backlogLoading, backlog, deadLettered = 0, triggers }: Props) {
  const navigate = useNavigate();

  // A cell whose figure comes from `backlog`, while that is still on its way.
  const pending = <Skeleton height={10} width={36} ml='auto' />;

  // The footer: the table's sums.
  //
  // ETA is the largest, not the sum: pipelines drain concurrently, so the archive is finished
  // when its slowest one is. Same rule `pool-stat` uses across a pool's kinds.
  const totals = rows.reduce((sum, row) => {
    const left = backlog?.[row.pipeline]?.left ?? 0;
    const etaMs = backlog?.[row.pipeline]?.etaMs;
    return {
      waiting: sum.waiting + left,
      queued: sum.queued + row.queued,
      running: sum.running + row.running,
      failed: sum.failed + row.failed,
      completed: sum.completed + row.completed,
      cancelled: sum.cancelled + row.cancelled,
      // Summed, unlike the ETA: pipelines run concurrently, so their rates add up while their
      // finishing times do not.
      perHour: sum.perHour + (backlog?.[row.pipeline]?.perHour ?? 0),
      inPerHour: sum.inPerHour + (backlog?.[row.pipeline]?.inPerHour ?? 0),
      etaMs: left > 0 && etaMs !== undefined ? Math.max(sum.etaMs, etaMs) : sum.etaMs,
    };
  }, { waiting: 0, queued: 0, running: 0, failed: 0, completed: 0, cancelled: 0, perHour: 0, inPerHour: 0, etaMs: 0 });

  return (
    <Card>
      {deadLettered > 0 && (
        <Group gap='xs' mb='md'>
          <IconTopologyRing size={18} />
          <Tooltip label='Queue entries that failed every delivery attempt and will not be retried — this work was dropped' withArrow>
            <Text size='sm' c='red'>{deadLettered.toLocaleString()} dropped</Text>
          </Tooltip>
        </Group>
      )}

      {loading
        ? (
          <Stack gap='sm'>
            {[0, 1, 2, 3, 4].map((key) => <Skeleton key={key} height={16} />)}
          </Stack>
        )
        : rows.length === 0
        ? <Text c='dimmed'>No instances yet</Text>
        : (
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Pipeline</Table.Th>
                <Table.Th w='30%'>Workload</Table.Th>
                <Table.Th ta='right'>Waiting</Table.Th>
                <Table.Th ta='right'>Queued</Table.Th>
                <Table.Th ta='right'>Running</Table.Th>
                <Table.Th ta='right'>Failed</Table.Th>
                <Table.Th ta='right'>Completed</Table.Th>
                <Table.Th ta='right'>Cancelled</Table.Th>
                <Table.Th ta='right'>In</Table.Th>
                <Table.Th ta='right'>Out</Table.Th>
                <Table.Th ta='right'>ETA</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row) => (
                <Table.Tr
                  key={row.pipeline}
                  style={{ cursor: 'pointer' }}
                  onClick={() => navigate(`/system/pipelines/${encodeURIComponent(row.pipeline)}`)}
                >
                  <Table.Td fw={500}>
                    {
                      /* What starts this pipeline. Nothing declares what *produces* a fact — the
                      archive bridge derives them from node state — so this is the consumer half
                      of the relationship, which is the half that is actually declared. Behind
                      a hover card so every row stays one line tall. */
                    }
                    <Group gap={4} wrap='nowrap'>
                      <Text size='sm' fw={500} style={{ whiteSpace: 'nowrap' }}>{row.pipeline}</Text>
                      {triggers?.[row.pipeline] && <TriggerPopover triggers={triggers[row.pipeline]} />}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    {
                      /* Waiting is in the bar as well as in its own column: without it the bar
                      would show only the instances a pipeline has made, and one with most of its
                      triggers still to turn into instances would draw as a full green bar. With
                      it the bar spans everything known about this pipeline's work. */
                    }
                    <WorkloadBar
                      height={8}
                      legend={false}
                      counts={{ completed: row.completed, queued: row.queued, running: row.running, failed: row.failed }}
                      waiting={backlog?.[row.pipeline]?.left ?? 0}
                      cancelled={row.cancelled}
                    />
                  </Table.Td>
                  <Table.Td ta='right' style={{ whiteSpace: 'nowrap' }}>
                    {
                      /* Work with no instance yet — a matched trigger the engine has not turned
                      into one. Distinct from Queued, which has an instance and is waiting on a
                      worker. */
                    }
                    {backlogLoading ? pending : (
                      <Group gap={6} justify='flex-end' wrap='nowrap'>
                        {(backlog?.[row.pipeline]?.left ?? 0) > 0 && <Box w={6} h={6} style={{ borderRadius: 2, background: WAITING_COLOR }} />}
                        <Text size='sm' c={(backlog?.[row.pipeline]?.left ?? 0) > 0 ? undefined : 'dimmed'}>
                          {(backlog?.[row.pipeline]?.left ?? 0).toLocaleString()}
                        </Text>
                      </Group>
                    )}
                  </Table.Td>
                  <Table.Td ta='right' style={{ whiteSpace: 'nowrap' }}>
                    <Group gap={6} justify='flex-end' wrap='nowrap'>
                      {row.queued > 0 && <Box w={6} h={6} style={{ borderRadius: 2, background: WORKLOAD_COLORS.queued }} />}
                      <Text size='sm' c={row.queued > 0 ? undefined : 'dimmed'}>{row.queued.toLocaleString()}</Text>
                    </Group>
                  </Table.Td>
                  <Table.Td ta='right' style={{ whiteSpace: 'nowrap' }}>
                    <Group gap={6} justify='flex-end' wrap='nowrap'>
                      {row.running > 0 && <Box w={6} h={6} style={{ borderRadius: 2, background: WORKLOAD_COLORS.running }} />}
                      <Text size='sm' c={row.running > 0 ? undefined : 'dimmed'}>{row.running}</Text>
                    </Group>
                  </Table.Td>
                  <Table.Td ta='right' style={{ whiteSpace: 'nowrap' }}>
                    <Group gap={6} justify='flex-end' wrap='nowrap'>
                      {row.failed > 0 && <Box w={6} h={6} style={{ borderRadius: 2, background: WORKLOAD_COLORS.failed }} />}
                      <Text size='sm' c={row.failed > 0 ? undefined : 'dimmed'}>{row.failed.toLocaleString()}</Text>
                    </Group>
                  </Table.Td>
                  <Table.Td ta='right' style={{ whiteSpace: 'nowrap' }}>
                    <Text size='sm'>{row.completed.toLocaleString()}</Text>
                  </Table.Td>
                  <Table.Td ta='right' style={{ whiteSpace: 'nowrap' }}>
                    {/* Stopped on purpose, kept as history: dimmed, since it asks nothing of the reader. */}
                    <Group gap={6} justify='flex-end' wrap='nowrap'>
                      {row.cancelled > 0 && <Box w={6} h={6} style={{ borderRadius: 2, background: CANCELLED_COLOR }} />}
                      <Text size='sm' c='dimmed'>{row.cancelled.toLocaleString()}</Text>
                    </Group>
                  </Table.Td>
                  <Table.Td ta='right' style={{ whiteSpace: 'nowrap' }}>
                    {
                      /* Arrival rate. Against Out it says whether this backlog is draining or
                      growing — a depth alone cannot distinguish the two. */
                    }
                    {backlogLoading ? pending : (
                      <Tooltip label='Jobs arriving per hour over the last hour' withArrow>
                        <Text size='sm' c={backlog?.[row.pipeline]?.inPerHour ? undefined : 'dimmed'}>
                          {backlog?.[row.pipeline]?.inPerHour === undefined ? '—' : `${formatCount(backlog[row.pipeline].inPerHour!)}/h`}
                        </Text>
                      </Tooltip>
                    )}
                  </Table.Td>
                  <Table.Td ta='right' style={{ whiteSpace: 'nowrap' }}>
                    {
                      /* The rate the ETA is computed from, shown beside it so a surprising estimate
                      can be read rather than guessed at. Measured over the last hour, so it is
                      what the machine is doing now and not a lifetime average. */
                    }
                    {backlogLoading ? pending : (
                      <Tooltip label='Completed in the last hour — the rate the ETA divides by' withArrow>
                        <Text size='sm' c={backlog?.[row.pipeline]?.perHour ? undefined : 'dimmed'}>
                          {backlog?.[row.pipeline]?.perHour === undefined ? '—' : `${formatCount(backlog[row.pipeline].perHour!)}/h`}
                        </Text>
                      </Tooltip>
                    )}
                  </Table.Td>
                  <Table.Td ta='right' style={{ whiteSpace: 'nowrap' }}>
                    {
                      /* No estimate rather than an optimistic one when there is no throughput to
                      divide by — an ETA off a stalled worker counts down forever. */
                    }
                    {backlogLoading ? pending : (
                      <Tooltip
                        label={backlog?.[row.pipeline]?.etaMs === undefined
                          ? 'No completions recently, so there is no rate to estimate from'
                          : 'At the rate this pipeline has completed work over the last hour'}
                        withArrow
                      >
                        <Text size='sm' c='dimmed'>
                          {(backlog?.[row.pipeline]?.left ?? 0) === 0
                            ? '—'
                            : backlog?.[row.pipeline]?.etaMs === undefined
                            ? 'no rate'
                            : formatDuration(backlog[row.pipeline].etaMs)}
                        </Text>
                      </Tooltip>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
            <Table.Tfoot>
              <Table.Tr>
                <Table.Td fw={600}>All pipelines</Table.Td>
                <Table.Td>
                  <WorkloadBar
                    height={8}
                    legend={false}
                    counts={{ completed: totals.completed, queued: totals.queued, running: totals.running, failed: totals.failed }}
                    waiting={totals.waiting}
                    cancelled={totals.cancelled}
                  />
                </Table.Td>
                <Table.Td ta='right' fw={600} style={{ whiteSpace: 'nowrap' }}>{backlogLoading ? pending : totals.waiting.toLocaleString()}</Table.Td>
                <Table.Td ta='right' fw={600} style={{ whiteSpace: 'nowrap' }}>{totals.queued.toLocaleString()}</Table.Td>
                <Table.Td ta='right' fw={600} style={{ whiteSpace: 'nowrap' }}>{totals.running.toLocaleString()}</Table.Td>
                <Table.Td ta='right' fw={600} style={{ whiteSpace: 'nowrap' }} c={totals.failed > 0 ? undefined : 'dimmed'}>{totals.failed.toLocaleString()}</Table.Td>
                <Table.Td ta='right' fw={600} style={{ whiteSpace: 'nowrap' }}>{totals.completed.toLocaleString()}</Table.Td>
                <Table.Td ta='right' fw={600} style={{ whiteSpace: 'nowrap' }} c='dimmed'>{totals.cancelled.toLocaleString()}</Table.Td>
                <Table.Td ta='right' fw={600} style={{ whiteSpace: 'nowrap' }}>
                  {backlogLoading ? pending : totals.inPerHour > 0 ? `${formatCount(totals.inPerHour)}/h` : '—'}
                </Table.Td>
                <Table.Td ta='right' fw={600} style={{ whiteSpace: 'nowrap' }}>
                  {backlogLoading ? pending : totals.perHour > 0 ? `${formatCount(totals.perHour)}/h` : '—'}
                </Table.Td>
                <Table.Td ta='right' fw={600} style={{ whiteSpace: 'nowrap' }} c='dimmed'>
                  {backlogLoading ? pending : totals.waiting === 0 ? '—' : totals.etaMs === 0 ? 'no rate' : formatDuration(totals.etaMs)}
                </Table.Td>
              </Table.Tr>
            </Table.Tfoot>
          </Table>
        )}
    </Card>
  );
}
