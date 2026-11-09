import { Anchor, Badge, Card, Group, SimpleGrid, Skeleton, Stack, Text } from '@mantine/core';
import { Link } from 'react-router-dom';
import type { DeviceInfo, DeviceSummary, EndpointSummary } from '@ein/api';
import { EndpointTile } from '../Devices/EndpointTile.tsx';
import { utilizationColor } from '../Pipeline/mod.ts';
import { usePolledCommand } from '../../hooks/useSystem.ts';
import { formatBytes } from '../../lib/format.ts';

/** The classes of device that can be a machine: a computer, a NAS. */
const MACHINE_CLASSES = 'host,storage';

/** What a machine's card shows, in order; `load` stands in for `cpu` where a machine has no share of its CPU. */
const SHOWN = ['cpu', 'memory-used', 'gpu', 'vram-used'];

/** EiN's own part of the machine it runs on, which the machine's device does not know. */
export type OwnShare = { device: string; cpuPercent?: number; memoryBytes?: number };

const GB = 2 ** 30;
const pct = (value?: number) => value === undefined ? '—' : `${Math.round(value)}%`;
const numberOf = (endpoint?: EndpointSummary): number | undefined => typeof endpoint?.last?.value === 'number' ? endpoint.last.value : undefined;

/** `12.4 GB of 31.3 GB`: a share of a total the device keeps in GB of 1024³ bytes. */
const ofTotal = (percent?: number, totalGb?: number): string | undefined =>
  percent !== undefined && totalGb !== undefined ? `${formatBytes(totalGb * GB * percent / 100)} of ${formatBytes(totalGb * GB)}` : undefined;

/** The endpoints a machine's card shows, each with the line under its value. */
const tilesOf = (info: DeviceInfo, own?: OwnShare): { endpoint: EndpointSummary; hint?: string; utilization?: boolean }[] => {
  const live = info.endpointList.filter((endpoint) => endpoint.type === 'log' && !endpoint.retired && endpoint.last);
  const byName = new Map(live.map((endpoint) => [endpoint.name, endpoint]));
  const value = (name: string) => numberOf(byName.get(name));
  const ein = own?.device === info.name ? own : undefined;
  const tiles: { endpoint: EndpointSummary; hint?: string; utilization?: boolean }[] = [];

  for (const name of byName.has('cpu') ? SHOWN : ['load', ...SHOWN.slice(1)]) {
    const endpoint = byName.get(name);
    if (!endpoint) continue;
    const parts: (string | undefined)[] = [];
    if (name === 'cpu') {
      parts.push(value('load') !== undefined ? `load ${value('load')!.toFixed(2)}` : undefined, ein?.cpuPercent !== undefined ? `EiN ${pct(ein.cpuPercent)}` : undefined);
    }
    if (name === 'memory-used') {
      parts.push(ofTotal(value('memory-used'), value('memory-total')), ein?.memoryBytes !== undefined ? `EiN ${formatBytes(ein.memoryBytes)}` : undefined);
    }
    if (name === 'gpu') {
      parts.push(
        value('gpu-temperature') !== undefined ? `${value('gpu-temperature')}°C` : undefined,
        value('gpu-power') !== undefined ? `${Math.round(value('gpu-power')!)} W` : undefined,
      );
    }
    if (name === 'vram-used') parts.push(ofTotal(value('vram-used'), value('vram-total')));
    const hint = parts.filter(Boolean).join(' · ');
    tiles.push({ endpoint, hint: hint || undefined, utilization: endpoint.unit === '%' });
  }

  // The hottest of its temperatures, the card's own excepted, which its GPU tile says.
  const hottest = live
    .filter((endpoint) => endpoint.deviceClass === 'temperature' && endpoint.name !== 'gpu-temperature' && numberOf(endpoint) !== undefined)
    .toSorted((a, b) => numberOf(b)! - numberOf(a)!)[0];
  const temperatures = live.filter((endpoint) => endpoint.deviceClass === 'temperature' && endpoint.name !== 'gpu-temperature').length;
  if (hottest) tiles.push({ endpoint: hottest, hint: temperatures > 1 ? `the hottest of ${temperatures}` : undefined });
  return tiles;
};

/** One machine: its name, opening its page, whether it answers, and its tiles; nothing for a device with no machine readings. */
function MachineCard({ device, own }: { device: DeviceSummary; own?: OwnShare }) {
  const { data: info } = usePolledCommand<DeviceInfo>(`device-show ${device.name}`);
  const tiles = info ? tilesOf(info, own) : [];
  if (info && tiles.length === 0) return null;

  return (
    <Card p='sm' withBorder>
      <Stack gap='xs'>
        <Group gap='xs' rowGap={2}>
          <Anchor component={Link} to={`/devices/${encodeURIComponent(device.name)}`} fw={600}>{device.label}</Anchor>
          {info?.online === true && <Badge size='xs' variant='light' color='green'>online</Badge>}
          {info?.online === false && <Badge size='xs' variant='light' color='red'>offline</Badge>}
          {device.model && <Text size='xs' c='dimmed' truncate>{device.model}</Text>}
        </Group>
        {!info ? <Skeleton height={86} /> : (
          <SimpleGrid cols={{ base: 2, sm: 3, lg: 5 }} spacing='sm'>
            {tiles.map(({ endpoint, hint, utilization }) => (
              <EndpointTile
                key={endpoint.name}
                device={device.name}
                deviceClass={device.class}
                endpoint={endpoint}
                hint={hint}
                accent={utilization ? utilizationColor(numberOf(endpoint)) : undefined}
                onChanged={() => {}}
                onHistory={() => {}}
              />
            ))}
          </SimpleGrid>
        )}
      </Stack>
    </Card>
  );
}

/**
 * The machines the reader may see, a card each: every device of a machine's class (`devices --class
 * host,storage`) that has a machine's readings, read with `device-show` — the one EiN runs on (core's
 * host driver), the media service's (ems), a NAS polled over SNMP. EiN's own machine comes first,
 * with EiN's part of its CPU and memory (`own`, from `host-metrics`). Each tile is the device's
 * reading with its last six hours, as on the device's page, which the card's name opens.
 */
export function Machines({ own }: { own?: OwnShare }) {
  const { data: devices } = usePolledCommand<DeviceSummary[]>(`devices --class ${MACHINE_CLASSES}`);
  if (!devices) return <Skeleton height={140} />;
  const ordered = devices.toSorted((a, b) => Number(b.name === own?.device) - Number(a.name === own?.device) || a.label.localeCompare(b.label));
  return (
    <Stack gap='sm'>
      {ordered.map((device) => <MachineCard key={device.name} device={device} own={own} />)}
    </Stack>
  );
}
