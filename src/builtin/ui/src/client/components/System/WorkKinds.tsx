import { Badge, Card, Group, Skeleton, Table, Text, Title, Tooltip } from '@mantine/core';
import type { PoolStatAnswer } from '@ein/api';
import { formatDuration } from '../../lib/format.ts';

type Props = {
  pools?: PoolStatAnswer[] | null;
};

/**
 * What the work pools hold, one row per kind of job: how much is left, how fast it comes and goes,
 * when it is done, how long the oldest job has waited — and, for a kind that is not moving, why.
 *
 * The pipeline table above counts work at the intake, by pipeline; the steps that take the time
 * run out of these pools, where one pool mixes face detection with video transcodes. A kind
 * resting because EMS could not run it says so here rather than look like a slow one.
 */
export function WorkKinds({ pools }: Props) {
  if (!pools) return <Skeleton height={80} />;
  const now = Date.now();
  const kinds = pools
    .filter((pool) => pool.role === 'work')
    .flatMap((pool) => (pool.kinds ?? []).map((kind) => ({ pool: pool.name, ...kind })))
    .filter((kind) => kind.ready + kind.claimed > 0 || kind.perHour);
  if (kinds.length === 0) return null;

  return (
    <Card>
      <Title order={4} mb='sm'>Kinds of work</Title>
      {/* Scrolls on its own on a phone rather than widen the page. */}
      <Table.ScrollContainer minWidth={640}>
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Kind</Table.Th>
              <Table.Th ta='right'>Left</Table.Th>
              <Table.Th ta='right'>Running</Table.Th>
              <Table.Th ta='right'>In</Table.Th>
              <Table.Th ta='right'>Out</Table.Th>
              <Table.Th ta='right'>ETA</Table.Th>
              <Table.Th ta='right'>Oldest waiting</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {kinds.map((kind) => (
              <Table.Tr key={`${kind.pool}/${kind.kind}`}>
                <Table.Td>
                  <Tooltip label={`pool ${kind.pool}`} withArrow>
                    <Text size='sm' ff='monospace'>{kind.kind}</Text>
                  </Tooltip>
                </Table.Td>
                <Table.Td ta='right'>{kind.ready.toLocaleString()}</Table.Td>
                <Table.Td ta='right'>{kind.claimed.toLocaleString()}</Table.Td>
                <Table.Td ta='right'>{kind.inPerHour !== undefined ? `${kind.inPerHour.toLocaleString()}/h` : '—'}</Table.Td>
                <Table.Td ta='right'>{kind.perHour !== undefined ? `${kind.perHour.toLocaleString()}/h` : '—'}</Table.Td>
                <Table.Td ta='right'>{formatDuration(kind.etaMs)}</Table.Td>
                <Table.Td ta='right'>{kind.oldestReadyAt !== undefined ? formatDuration(now - kind.oldestReadyAt) : '—'}</Table.Td>
                <Table.Td>
                  <Group gap={4} justify='flex-end' wrap='nowrap'>
                    {kind.unservableSince !== undefined && <Badge size='xs' color='red' variant='light'>no worker</Badge>}
                    {kind.restingUntil !== undefined && (
                      <Tooltip label={`next try in ${formatDuration(kind.restingUntil - now)}`} withArrow>
                        <Badge size='xs' color='yellow' variant='light'>waiting for EMS</Badge>
                      </Tooltip>
                    )}
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Card>
  );
}
