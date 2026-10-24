import { Box, Group, Text, Tooltip } from '@mantine/core';
import { SURFACE_GAP_PX } from './palette.ts';

export type BarSegment = {
  key: string;
  label: string;
  color: string;
  value: number;
};

type Props = {
  segments: BarSegment[];
  height?: number;
  legend?: boolean;
  /** Overrides the derived "Label: n (p%)" tooltip — used where the unit is bytes. */
  describe?: (segment: BarSegment, total: number) => string;
  emptyLabel?: string;
};

const compact = (value: number): string => value >= 10000 ? `${(value / 1000).toFixed(1)}k` : value.toLocaleString();

/**
 * A 100%-stacked bar: parts of a whole, in proportion.
 *
 * Segments are separated by a gap in the surface color rather than a border —
 * a stroke around each segment would read as its own mark. Every segment
 * carries a tooltip, and the legend names each one, so identity is never
 * carried by color alone.
 *
 * The workload bar and the storage tiers are the same picture of the same kind
 * of fact, so they are the same component; what differs between them (which
 * states exist, how a value is worded) is passed in.
 */
export function StackedBar({ segments, height = 14, legend = true, describe, emptyLabel = 'Empty' }: Props) {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);
  const present = segments.filter((segment) => segment.value > 0);

  const label = (segment: BarSegment) => describe?.(segment, total) ?? `${segment.label}: ${segment.value.toLocaleString()} (${Math.round((segment.value / total) * 100)}%)`;

  return (
    <Box>
      <Box
        style={{
          display: 'flex',
          gap: SURFACE_GAP_PX,
          height,
          borderRadius: 2,
          overflow: 'hidden',
          background: 'var(--mrx-surface-raised)',
        }}
        role='img'
        aria-label={present.map(label).join(', ') || emptyLabel}
      >
        {total === 0 ? <Box style={{ flex: 1 }} /> : present.map((segment) => (
          <Tooltip key={segment.key} label={label(segment)} withArrow>
            <Box
              style={{
                flexGrow: segment.value,
                flexBasis: 0,
                // Segments can round to nothing at this scale; a sliver is
                // still the truth, and it keeps the tooltip reachable.
                minWidth: 3,
                background: segment.color,
                cursor: 'default',
              }}
            />
          </Tooltip>
        ))}
      </Box>

      {legend && (
        <Group gap='lg' mt='xs'>
          {segments.map((segment) => (
            <Group key={segment.key} gap={6} wrap='nowrap'>
              <Box w={8} h={8} style={{ borderRadius: 2, background: segment.color, flexShrink: 0 }} />
              <Text size='xs' c='dimmed'>{segment.label}</Text>
              <Text size='xs' fw={600}>{compact(segment.value)}</Text>
            </Group>
          ))}
        </Group>
      )}
    </Box>
  );
}
