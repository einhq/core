import { Card, SimpleGrid, Skeleton } from '@mantine/core';
import { IconCpu, IconDeviceSdCard } from '@tabler/icons-react';
import { StatTile, utilizationColor } from '../Pipeline/mod.ts';
import { formatBytes } from '../../lib/format.ts';
import type { HostMetrics as Metrics } from '@ein/api';

type Props = {
  cpu: Metrics['cpu'];
  memory: Metrics['memory'];
  /** Nothing fetched yet: draws placeholder tiles, since absent sources would otherwise read as no hardware. */
  loading?: boolean;
};

/** Shaped like a StatTile — label, value, hint, sparkline — so the grid does not jump when the numbers land. */
function TileSkeleton() {
  return (
    <Card p='sm'>
      <Skeleton height={12} width='40%' mb={8} />
      <Skeleton height={26} width='55%' mb={6} />
      <Skeleton height={10} width='65%' mb={10} />
      <Skeleton height={28} />
    </Card>
  );
}

const pct = (value?: number) => value === undefined ? '—' : `${Math.round(value)}%`;

/**
 * The machine's CPU and memory, each with EiN's share: with the GPU a module draws beside them (a `system.overview`
 * panel), the numbers that say whether the machine is coping.
 *
 * Each tile is one series, so there is no legend and no per-metric hue — the
 * label names the metric and the color says how close it is to its ceiling
 * (see UTILIZATION_BANDS). A tile whose source is absent is omitted rather than
 * shown at zero.
 */
export function HostMetrics({ cpu, memory, loading }: Props) {
  if (loading) {
    return (
      <SimpleGrid cols={2} spacing='sm'>
        {[0, 1].map((key) => <TileSkeleton key={key} />)}
      </SimpleGrid>
    );
  }

  return (
    <SimpleGrid cols={2} spacing='sm'>
      {cpu && (
        <StatTile
          label='CPU'
          value={pct(cpu.percent)}
          accent={utilizationColor(cpu.percent)}
          icon={<IconCpu size={14} />}
          hint={`${cpu.cores} cores${cpu.load1 !== undefined ? ` · load ${cpu.load1.toFixed(2)}` : ''}${cpu.ownPercent !== undefined ? ` · EiN ${pct(cpu.ownPercent)}` : ''}`}
          tooltip="Share of all the machine's cores in use; EiN is this container's part of it"
          series={cpu.series}
        />
      )}

      {memory?.machine && (
        <StatTile
          label='Memory'
          value={pct(memory.machine.percent)}
          accent={utilizationColor(memory.machine.percent)}
          icon={<IconDeviceSdCard size={14} />}
          hint={`${formatBytes(memory.machine.usedBytes)} of ${formatBytes(memory.machine.totalBytes)} · EiN ${pct((memory.usedBytes / memory.machine.totalBytes) * 100)}`}
          tooltip={`The machine's memory in use; EiN is this container's part of it, ${formatBytes(memory.usedBytes)} of the ${formatBytes(memory.limitBytes)} it may hold`}
          series={memory.machine.series}
        />
      )}
      {memory && !memory.machine && (
        <StatTile
          label='Memory'
          value={pct(memory.percent)}
          accent={utilizationColor(memory.percent)}
          icon={<IconDeviceSdCard size={14} />}
          hint={`${formatBytes(memory.usedBytes)} of ${formatBytes(memory.limitBytes)}`}
          tooltip="EiN's memory against what it may hold; the machine's is not readable here"
          series={memory.series}
        />
      )}
    </SimpleGrid>
  );
}
