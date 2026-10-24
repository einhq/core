import { Card, Group, Skeleton, Text } from '@mantine/core';
import { formatBytes, formatUptime } from '../../lib/format.ts';
import type { SystemInfo } from '@ein/api';

/** `instance` is absent until the first answer arrives; `databaseBytes` comes from `df`. */
type Props = { instance?: SystemInfo; databaseBytes?: number };

/** One fact and its label. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <Group gap={6} wrap='nowrap'>
      <Text size='xs' c='dimmed'>{label}</Text>
      <Text size='xs' ff='monospace'>{value}</Text>
    </Group>
  );
}

/**
 * Which instance you are looking at.
 *
 * A footer rather than a card with a heading: it answers a question nobody asks
 * until something is confusing — usually "am I in production or on my laptop" — and it
 * should cost no vertical space until then.
 */
export function InstanceInfo({ instance, databaseBytes }: Props) {
  if (!instance) {
    return (
      <Card py='xs'>
        <Skeleton height={12} my={3} width='60%' />
      </Card>
    );
  }

  return (
    <Card py='xs'>
      <Group gap='xl' wrap='wrap'>
        {instance.hostname && <Fact label='host' value={instance.hostname} />}
        <Fact label='uptime' value={formatUptime(instance.uptimeMs)} />
        <Fact label='deno' value={instance.denoVersion} />
        {databaseBytes !== undefined && <Fact label='database' value={formatBytes(databaseBytes)} />}
      </Group>
    </Card>
  );
}
