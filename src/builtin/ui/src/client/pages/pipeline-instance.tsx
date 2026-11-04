import { Badge, Box, Button, Card, Code, Container, Group, Loader, Stack, Table, Text, Title } from '@mantine/core';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { useCallback, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { elapsed, EntityDetailHeader, type PageAction, statusColor } from '@ein/ui/components';
import { type PipelineStep, useAccessIds, usePipelineActions, usePipelineStatus } from '@ein/ui/hooks';
import { HeaderTrail } from '../components/EntityDetail/HeaderTrail.tsx';
import { SYSTEM_TRAIL } from './pipeline.tsx';

const formatTime = (ts?: number) => ts ? new Date(ts).toLocaleString() : '-';
const duration = (start?: number, end?: number) => start ? elapsed(start, end ?? Date.now()) : '-';

/**
 * A step row. A failed or skipped step offers **Retry**, a running one **Restart**, which stops
 * its command first; without `onRestart` — anyone but the administrator — neither.
 */
function StepRow({ step, onRestart, busy }: { step: PipelineStep; onRestart?: () => void; busy: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = Boolean(step.error || step.exitCode !== undefined || step.attempts || step.pool);
  const restartable = onRestart !== undefined && (step.status === 'failed' || step.status === 'skipped' || step.status === 'running');

  return (
    <>
      <Table.Tr style={{ cursor: hasDetail ? 'pointer' : 'default' }} onClick={hasDetail ? () => setExpanded((e) => !e) : undefined}>
        <Table.Td>
          {hasDetail ? (expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />) : <Box w={14} />}
        </Table.Td>
        <Table.Td fw={500}>{step.stepName}</Table.Td>
        <Table.Td>
          <Group gap={6} wrap='nowrap'>
            <Badge color={statusColor(step.status)} variant='light' size='sm'>{step.status}</Badge>
            {
              /* A 'waiting' step is parked on a worker's queue — say which one,
                otherwise "waiting" gives no clue what it is waiting for — and
                whether it has run before, i.e. is waiting to be retried. */
            }
            {step.status === 'waiting' && step.pool && <Text size='xs' c='dimmed' ff='monospace'>{step.pool}{step.kind ? ` · ${step.kind}` : ''}</Text>}
            {step.status === 'waiting' && (step.attempts ?? 0) > 0 && <Text size='xs' c='orange'>retrying, {step.attempts}/{step.maxAttempts ?? '?'} tried</Text>}
            {step.status === 'running' && <Text size='xs' c='dimmed'>{step.outputAt ? `last output ${duration(step.outputAt)} ago` : 'no output yet'}</Text>}
          </Group>
        </Table.Td>
        <Table.Td>
          <Text size='xs' c='dimmed'>{step.dependsOn?.join(', ') || '-'}</Text>
        </Table.Td>
        <Table.Td>
          <Text size='xs' ff='monospace' truncate maw={360} title={step.command}>{step.command}</Text>
        </Table.Td>
        <Table.Td ta='right'>
          {
            /* A waiting step is timed from when it last went into the queue, so a
              retry reads how long it has waited since its last run. */
          }
          <Text size='sm' c='dimmed' title={step.status === 'waiting' ? 'Waiting in the pool' : undefined}>
            {step.status === 'waiting' ? duration(step.waitingSince) : duration(step.startedAt, step.completedAt)}
          </Text>
        </Table.Td>
        <Table.Td onClick={(e) => e.stopPropagation()}>
          {restartable && (
            <Button size='compact-xs' variant='subtle' loading={busy} onClick={onRestart}>
              {step.status === 'running' ? 'Restart' : 'Retry'}
            </Button>
          )}
        </Table.Td>
      </Table.Tr>

      {expanded && (
        <Table.Tr>
          <Table.Td colSpan={7} p={0}>
            <Box bg='var(--mrx-surface-sunken)' p='md'>
              <Stack gap='sm'>
                <Group gap='lg'>
                  {step.exitCode !== undefined && (
                    <Text size='xs' c='dimmed'>
                      Exit code: <Text span fw={500} c={step.exitCode === 0 ? 'teal' : 'red'}>{step.exitCode}</Text>
                    </Text>
                  )}
                  {step.maxAttempts !== undefined && <Text size='xs' c='dimmed'>Attempts: {step.attempts ?? 0}/{step.maxAttempts}</Text>}
                  {step.pool && <Text size='xs' c='dimmed'>Pool: {step.pool}{step.kind ? ` · ${step.kind}` : ''}</Text>}
                  {step.condition && (
                    <Text size='xs' c='dimmed'>
                      Condition: <Text span ff='monospace'>{step.condition}</Text>
                    </Text>
                  )}
                </Group>
                {step.error && (
                  <Box>
                    <Text size='sm' fw={500} c='red' mb={4}>Error</Text>
                    <Code block>{step.error}</Code>
                  </Box>
                )}
              </Stack>
            </Box>
          </Table.Td>
        </Table.Tr>
      )}
    </>
  );
}

export default function InstanceDetailPage() {
  const { pipeline, id } = useParams<{ pipeline: string; id: string }>();
  const navigate = useNavigate();
  const { data, loading, error, refetch } = usePipelineStatus(pipeline ?? null, id ?? null);
  const { rerun, cancel, remove, restartStep } = usePipelineActions();
  const admin = useAccessIds()?.admin === true;
  const [busy, setBusy] = useState(false);

  const ref = pipeline && id ? `${pipeline}/${id}` : '';
  const back = () => navigate(`/system/pipelines/${encodeURIComponent(pipeline ?? '')}`);

  const act = useCallback(async (action: () => Promise<unknown>, thenBack = false) => {
    setBusy(true);
    try {
      await action();
      if (thenBack) back();
      else await refetch();
    } finally {
      setBusy(false);
    }
  }, [refetch, pipeline, navigate]);

  if (!pipeline || !id) return <Text>Missing instance reference</Text>;

  // Rerun stands in the header's corner; Cancel beside it while there is something to stop.
  const actions: PageAction[] = admin
    ? [
      { label: 'Rerun', icon: 'refresh', onClick: () => void act(() => rerun([ref])), disabled: busy, button: true },
      ...(data?.status === 'running' || data?.status === 'queued')
        ? [{ label: 'Cancel', icon: 'player-stop', color: 'orange', onClick: () => void act(() => cancel([ref])), disabled: busy, button: true }]
        : [],
      { label: 'Remove', icon: 'trash', color: 'red', onClick: () => void act(() => remove([ref]), true), disabled: busy },
    ]
    : [];

  // The run is named by what it ran on; its pipeline is the trail's last step, above it.
  return (
    <>
      <EntityDetailHeader
        eyebrow={<HeaderTrail steps={[...SYSTEM_TRAIL, { label: pipeline, to: `/system/pipelines/${encodeURIComponent(pipeline)}` }]} />}
        title={data?.triggerPath.split('/').filter(Boolean).pop() || data?.triggerPath || id}
        name={`${pipeline} run ${id}`}
        pattern='mixed'
        subtitle={data && <Text size='sm' c='gray.2' ff='monospace'>{data.triggerPath}</Text>}
        meta={loading && !data && <Loader size='sm' color='white' />}
        actions={actions.length > 0 ? { items: actions } : undefined}
        flowContent
      />

      <Container py='md' px='md'>
        <Stack gap='lg'>
          {error && <Text c='red'>{error.message}</Text>}

          {data && (
            <>
              <Card>
                <Group gap='xl'>
                  <Box>
                    <Text size='xs' c='dimmed'>Status</Text>
                    <Badge color={statusColor(data.status)} variant='light' mt={4}>{data.status}</Badge>
                  </Box>
                  <Box>
                    <Text size='xs' c='dimmed'>Started</Text>
                    <Text size='sm' mt={4}>{formatTime(data.startedAt)}</Text>
                  </Box>
                  <Box>
                    <Text size='xs' c='dimmed'>Duration</Text>
                    <Text size='sm' mt={4}>{duration(data.startedAt, data.completedAt)}</Text>
                  </Box>
                </Group>
                <Text size='xs' c='dimmed' mt='sm' ff='monospace'>{ref}</Text>
              </Card>

              <Card>
                <Title order={4} mb='md'>Steps</Title>
                <Table striped>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th w={30} />
                      <Table.Th>Step</Table.Th>
                      <Table.Th>Status</Table.Th>
                      <Table.Th>Depends on</Table.Th>
                      <Table.Th>Command</Table.Th>
                      <Table.Th ta='right'>Duration</Table.Th>
                      <Table.Th w={70} />
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {data.steps.map((step) => (
                      <StepRow
                        key={step.stepName}
                        step={step}
                        busy={busy}
                        onRestart={admin ? () => act(() => restartStep(ref, step.stepName)) : undefined}
                      />
                    ))}
                  </Table.Tbody>
                </Table>
              </Card>
            </>
          )}
        </Stack>
      </Container>
    </>
  );
}
