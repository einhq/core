import { Alert, Anchor, Badge, Card, Group, Skeleton, Stack, Table, Text, Title } from '@mantine/core';
import { IconActivity, IconAlertTriangle } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { PipelineOverview } from '@ein/ui/hooks';

type Props = {
  /** Absent until the first answer arrives. */
  active?: PipelineOverview['active'];
  /** Running steps that have written nothing for `quietMs`. */
  quiet?: PipelineOverview['quiet'];
  quietMs?: number;
};

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1) || path;

export function elapsed(since: number, now = Date.now()): string {
  const ms = Math.max(0, now - since);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * The instances currently in flight.
 *
 * Bounded to what the overview returns, so this stays a list of what is
 * happening rather than a listing of everything that ever happened. The
 * elapsed column ticks locally — it is derived from a timestamp we already
 * have, so keeping it live costs nothing and a stalled instance becomes
 * obvious without waiting for the next event.
 *
 * Steps that have gone quiet are listed above it as a warning: nothing stops
 * them, so a person decides whether one is stuck.
 */
export function ActiveInstances({ active, quiet, quietMs }: Props) {
  const navigate = useNavigate();
  const [now, setNow] = useState(() => Date.now());

  const count = active?.length ?? 0;
  const ticking = count > 0 || (quiet?.length ?? 0) > 0;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  return (
    <Card>
      <Group gap='xs' mb='md'>
        <IconActivity size={18} />
        <Title order={4}>Ongoing</Title>
        {count > 0 && <Badge variant='light' size='sm'>{count}</Badge>}
      </Group>

      {quiet && quiet.length > 0 && (
        <Alert
          color='yellow'
          variant='light'
          icon={<IconAlertTriangle size={16} />}
          mb='md'
          title={`${quiet.length} ${quiet.length === 1 ? 'step has' : 'steps have'} written nothing for ${quietMs ? elapsed(0, quietMs) : 'a long while'}`}
        >
          <Stack gap={2}>
            {quiet.map((step) => (
              <Text key={step.path} size='sm'>
                <Anchor
                  size='sm'
                  onClick={() => navigate(`/system/pipelines/${encodeURIComponent(step.pipeline)}/${step.id}`)}
                >
                  {step.pipeline} · {step.step}
                </Anchor>{' '}
                running {elapsed(step.startedAt, now)}, {step.outputAt === undefined ? 'no output yet' : `last output ${elapsed(step.outputAt, now)} ago`}
              </Text>
            ))}
            <Text size='xs' c='dimmed'>Still running; nothing stops a step for taking long.</Text>
          </Stack>
        </Alert>
      )}

      {!active
        ? (
          <Stack gap='sm'>
            {[0, 1, 2].map((key) => <Skeleton key={key} height={16} />)}
          </Stack>
        )
        : active.length === 0
        ? <Text c='dimmed'>Nothing running</Text>
        : (
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Pipeline</Table.Th>
                <Table.Th>Target</Table.Th>
                <Table.Th ta='right'>Elapsed</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {active.map((instance) => (
                <Table.Tr
                  key={`${instance.pipeline}/${instance.id}`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => navigate(`/system/pipelines/${encodeURIComponent(instance.pipeline)}/${instance.id}`)}
                >
                  <Table.Td fw={500}>{instance.pipeline}</Table.Td>
                  <Table.Td>
                    <Text size='sm' truncate maw={420} title={instance.triggerPath}>{basename(instance.triggerPath)}</Text>
                  </Table.Td>
                  <Table.Td ta='right'>
                    {
                      /* Time spent *executing*, not instance age. This panel is titled "In flight",
                      and an instance that waited ten minutes in a pool for a five-second caption
                      would otherwise read ten minutes here. */
                    }
                    <Text size='sm' c='dimmed'>{elapsed(instance.executingSince ?? instance.startedAt, now)}</Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
    </Card>
  );
}
