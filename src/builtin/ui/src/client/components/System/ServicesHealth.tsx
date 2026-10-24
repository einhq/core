import { ActionIcon, Badge, Card, Group, Loader, Skeleton, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { IconPlayerPlay, IconPlayerStop, IconRefresh, IconServer2 } from '@tabler/icons-react';
import { useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { useAccessIds } from '../../hooks/useAccessIds.ts';
import { formatUptime } from '../../lib/format.ts';
import type { ServiceEntry } from '@ein/api';

type Service = ServiceEntry;

type Props = {
  /** Absent until the first answer arrives. */
  services?: Service[];
  /** Re-read the list after an action, so the row reflects what happened. */
  onChanged?: () => void;
};

/** The colour of a service's status badge. */
export const SERVICE_STATUS_COLOR: Record<string, string> = {
  running: 'teal',
  starting: 'blue',
  stopping: 'blue',
  stopped: 'gray',
  failed: 'red',
};

/**
 * Which services are up, and the controls to change that.
 *
 * Sorted by what is wrong rather than by name: an enabled service that is not
 * running is the only row anyone opens this panel to find, and on a healthy
 * instance it is also the only row that is not identical to its neighbours. A
 * disabled service is listed but never flagged — it is off on purpose, and it
 * gets no start button either, because `service start` refuses one that is not
 * enabled rather than enabling it silently.
 *
 * Uptime is shown rather than a start timestamp. "running" alone cannot
 * distinguish a service that has been up for weeks from one that crash-looped
 * back thirty seconds ago, which is exactly the distinction this panel exists
 * to make; the absolute time is in the tooltip for when it is wanted.
 *
 * `detail` is the service speaking for itself, from the `statusCommand` it
 * declares. It takes the description's location when there is one, because a
 * service that is up and nonetheless degraded — the model server captioning on
 * the CPU at a fifth of its rate — is the only thing on this row worth reading,
 * and a static description is the least.
 *
 * Starting and stopping a service is the administrator's, so only they get the controls.
 */
export function ServicesHealth({ services, onChanged }: Props) {
  const admin = useAccessIds()?.admin === true;
  // Per service, so one slow stop does not lock the whole table.
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const run = async (name: string, action: 'start' | 'stop' | 'restart') => {
    setBusy((current) => ({ ...current, [name]: true }));
    setError(null);
    try {
      await execCommand(`service ${action} ${name}`);
      onChanged?.();
    } catch (err) {
      setError(`${action} ${name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy((current) => ({ ...current, [name]: false }));
    }
  };

  const rank = (service: Service) => {
    if (service.enabled && service.status === 'failed') return 0;
    if (service.enabled && service.status !== 'running') return 1;
    if (service.restartCount > 0) return 2;
    return 3;
  };

  const rows = [...(services ?? [])].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const down = rows.filter((service) => service.enabled && service.status !== 'running').length;

  return (
    <Card>
      <Group gap='xs' mb='md'>
        <IconServer2 size={18} />
        <Title order={4}>Services</Title>
        {services && (
          <Text size='sm' c={down > 0 ? 'red' : 'dimmed'} ml='auto' fw={down > 0 ? 600 : 400}>
            {down > 0 ? `${down} down` : `${rows.length} healthy`}
          </Text>
        )}
      </Group>

      {error && <Text size='xs' c='red' mb='xs'>{error}</Text>}

      {!services
        ? (
          <Stack gap='sm'>
            {[0, 1, 2, 3].map((key) => <Skeleton key={key} height={28} />)}
          </Stack>
        )
        : rows.length === 0
        ? <Text c='dimmed'>No services</Text>
        : (
          <Table striped highlightOnHover verticalSpacing='xs'>
            <Table.Tbody>
              {rows.map((service) => (
                <Table.Tr key={service.name}>
                  <Table.Td>
                    <Stack gap={0}>
                      <Text size='sm' ff='monospace' c={service.enabled ? undefined : 'dimmed'}>{service.name}</Text>
                      {service.detail
                        ? (
                          <Tooltip label={service.description} withArrow disabled={!service.description}>
                            <Text size='xs' c='dimmed'>{service.detail}</Text>
                          </Tooltip>
                        )
                        : service.description && <Text size='xs' c='dimmed'>{service.description}</Text>}
                    </Stack>
                  </Table.Td>

                  <Table.Td ta='right' style={{ width: 110, whiteSpace: 'nowrap' }}>
                    {service.status === 'running' && service.startedAt !== undefined && (
                      <Tooltip label={`Started ${new Date(service.startedAt).toLocaleString()}`} withArrow>
                        <Text size='xs' c='dimmed'>up {formatUptime(Date.now() - service.startedAt)}</Text>
                      </Tooltip>
                    )}
                  </Table.Td>

                  <Table.Td ta='right' style={{ width: 120 }}>
                    <Group gap={6} justify='flex-end' wrap='nowrap'>
                      {service.restartCount > 0 && (
                        <Tooltip label={`Restarted ${service.restartCount} time(s)`} withArrow>
                          <Text size='xs' c='dimmed'>×{service.restartCount}</Text>
                        </Tooltip>
                      )}
                      <Badge size='sm' variant='light' color={SERVICE_STATUS_COLOR[service.status] ?? 'gray'}>
                        {service.enabled ? service.status : 'disabled'}
                      </Badge>
                    </Group>
                  </Table.Td>

                  {admin && (
                    <Table.Td ta='right' style={{ width: 82 }}>
                      <Actions service={service} busy={Boolean(busy[service.name])} run={run} />
                    </Table.Td>
                  )}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
    </Card>
  );
}

function Actions(
  { service, busy, run }: {
    service: Service;
    busy: boolean;
    run: (name: string, action: 'start' | 'stop' | 'restart') => void;
  },
) {
  if (busy) return <Loader size='xs' />;

  // A disabled service has no controls: `service start` rejects it outright, so
  // a start button here would only ever produce an error.
  if (!service.enabled) {
    return (
      <Tooltip label='Disabled — enable it from the shell to run it' withArrow>
        <Text size='xs' c='dimmed'>—</Text>
      </Tooltip>
    );
  }

  // `starting`/`stopping` are transitional and settle on their own. Offering a
  // button there invites acting on a state that is already changing — a restart
  // sits in `stopping` for a moment, and a Start button appearing during it
  // would race the restart it belongs to.
  if (service.status === 'starting' || service.status === 'stopping') {
    return (
      <Tooltip label={`${service.status}…`} withArrow>
        <Loader size='xs' />
      </Tooltip>
    );
  }

  const running = service.status === 'running';

  return (
    <Group gap={2} justify='flex-end' wrap='nowrap'>
      {running
        ? (
          <>
            <Tooltip label='Restart' withArrow>
              <ActionIcon variant='subtle' size='sm' onClick={() => run(service.name, 'restart')} aria-label={`Restart ${service.name}`}>
                <IconRefresh size={15} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label='Stop' withArrow>
              <ActionIcon variant='subtle' size='sm' color='red' onClick={() => run(service.name, 'stop')} aria-label={`Stop ${service.name}`}>
                <IconPlayerStop size={15} />
              </ActionIcon>
            </Tooltip>
          </>
        )
        : (
          <Tooltip label='Start' withArrow>
            <ActionIcon variant='subtle' size='sm' color='teal' onClick={() => run(service.name, 'start')} aria-label={`Start ${service.name}`}>
              <IconPlayerPlay size={15} />
            </ActionIcon>
          </Tooltip>
        )}
    </Group>
  );
}
