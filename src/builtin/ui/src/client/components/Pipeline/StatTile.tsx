import { Box, Card, Group, Text, Tooltip } from '@mantine/core';
import type { ReactNode } from 'react';
import { type MetricPoint, MetricSparkline } from './MetricSparkline.tsx';

type Props = {
  label: string;
  value: number | string;
  /** Small qualifier under the value ("in the last hour"). */
  hint?: string;
  /** Dot color — a status hue when the tile maps to a workload state. */
  accent?: string;
  icon?: ReactNode;
  tooltip?: string;
  /** History for this number, drawn under it. Host metrics use this; counts don't. */
  series?: MetricPoint[];
  /** Ceiling for `series`, when it is not a percentage. */
  seriesMax?: number;
  seriesUnit?: string;
};

const compact = (value: number | string): string => {
  if (typeof value === 'string') return value;
  if (value >= 100000) return `${(value / 1000).toFixed(0)}k`;
  if (value >= 10000) return `${(value / 1000).toFixed(1)}k`;
  return value.toLocaleString();
};

/**
 * One number with its label. The accent dot repeats the workload bar's hue so
 * the tile and the bar read as the same system — the value itself stays in ink
 * rather than wearing the data color.
 */
export function StatTile({ label, value, hint, accent, icon, tooltip, series, seriesMax, seriesUnit }: Props) {
  const body = (
    <Card p='sm'>
      <Group gap={6} wrap='nowrap' mb={4}>
        {accent && <Box w={8} h={8} style={{ borderRadius: 2, background: accent, flexShrink: 0 }} />}
        {icon}
        <Text size='xs' c='dimmed' truncate>{label}</Text>
      </Group>
      <Text fz={28} fw={600} lh={1.1}>{compact(value)}</Text>
      {hint && <Text size='xs' c='dimmed' mt={2}>{hint}</Text>}
      {series && (
        <Box mt={8}>
          {
            /* The sparkline wears the tile's accent, so the number and its
              history are one mark rather than two things that happen to sit
              in the same box. */
          }
          <MetricSparkline points={series} height={28} max={seriesMax ?? 100} unit={seriesUnit ?? '%'} color={accent} />
        </Box>
      )}
    </Card>
  );

  return tooltip ? <Tooltip label={tooltip} withArrow>{body}</Tooltip> : body;
}
