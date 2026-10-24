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
 * The container's CPU and memory: with the GPU a module draws beside them (a `system.overview`
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
          hint={`${cpu.cores} cores${cpu.load1 !== undefined ? ` · load ${cpu.load1.toFixed(2)}` : ''}`}
          tooltip='Share of all cores used by this container'
          series={cpu.series}
        />
      )}

      {memory && (
        <StatTile
          label='Memory'
          value={pct(memory.percent)}
          accent={utilizationColor(memory.percent)}
          icon={<IconDeviceSdCard size={14} />}
          hint={`${formatBytes(memory.usedBytes)} of ${formatBytes(memory.limitBytes)}`}
          tooltip='Resident memory against the container cap'
          series={memory.series}
        />
      )}
    </SimpleGrid>
  );
}
