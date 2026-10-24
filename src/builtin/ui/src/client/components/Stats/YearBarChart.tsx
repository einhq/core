import { Box, Card, Group, Skeleton, Text, Title, Tooltip } from '@mantine/core';
import type { ReactNode } from 'react';

type Props<T extends { year: string }> = {
  title: string;
  icon: ReactNode;
  growth: T[];
  value: (point: T) => number;
  format: (value: number) => string;
  color: string;
  total: string;
  description: string;
  line?: {
    points: { month: string; value: number }[];
    color: string;
    label: string;
    format: (value: number) => string;
  };
};

const HEIGHT = 170;

/** Annual additions with calendar years on the horizontal axis. */
export function YearBarChart<T extends { year: string }>({ title, icon, growth, value, format, color, total, description, line }: Props<T>) {
  const peak = Math.max(1, ...growth.map(value));
  const minWidth = Math.max(420, growth.length * 44);
  const linePeak = Math.max(1, ...(line?.points.map((point) => point.value) ?? []));
  const lineCoordinates = line?.points.flatMap((point) => {
    const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(point.month);
    if (!match) return [];
    const yearIndex = growth.findIndex((annual) => annual.year === match[1]);
    if (yearIndex < 0) return [];
    const month = Number(match[2]);
    return [{
      x: ((yearIndex + month / 12) / growth.length) * 1000,
      y: HEIGHT - (point.value / linePeak) * (HEIGHT - 4),
    }];
  }) ?? [];
  const polyline = lineCoordinates.length > 0 ? [{ x: 0, y: HEIGHT }, ...lineCoordinates].map((point) => `${point.x},${point.y}`).join(' ') : '';
  const lineSummary = line && line.points.length > 0
    ? `${line.label}: ${line.points[0].month} ${line.format(line.points[0].value)} to ${line.points[line.points.length - 1].month} ${
      line.format(line.points[line.points.length - 1].value)
    }`
    : '';

  return (
    <Card>
      <Group gap='xs' mb='md' wrap='nowrap'>
        {icon}
        <Title order={4}>{title}</Title>
        <Text size='sm' c='dimmed' ml='auto'>{total}</Text>
      </Group>

      <Group gap='xs' align='stretch' wrap='nowrap'>
        <Box
          style={{ height: HEIGHT, width: 52, flexShrink: 0, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}
        >
          <Text size='xs' c='dimmed' ta='right'>{format(peak)}</Text>
          <Text size='xs' c='dimmed' ta='right'>0</Text>
        </Box>

        <Box style={{ flex: 1, minWidth: 0, overflowX: 'auto' }}>
          <Box style={{ minWidth }}>
            <Box
              role='img'
              aria-label={`${title}: ${growth.map((point) => `${point.year} ${format(value(point))}`).join(', ')}${lineSummary ? `. ${lineSummary}` : ''}`}
              style={{
                height: HEIGHT,
                position: 'relative',
                display: 'flex',
                alignItems: 'flex-end',
                gap: 4,
                borderBottom: '1px solid var(--mrx-border-subtle)',
                backgroundImage: 'linear-gradient(to bottom, var(--mrx-border-subtle) 1px, transparent 1px)',
                backgroundSize: '100% 50%',
              }}
            >
              {growth.map((point) => {
                const amount = value(point);
                return (
                  <Tooltip key={point.year} label={`${point.year}: ${format(amount)}`} withArrow openDelay={0}>
                    <Box
                      style={{
                        flex: 1,
                        minWidth: 12,
                        height: amount > 0 ? Math.max(2, (amount / peak) * HEIGHT) : 1,
                        background: amount > 0 ? color : 'var(--mrx-surface-overlay)',
                        borderRadius: '3px 3px 0 0',
                        cursor: 'default',
                      }}
                    />
                  </Tooltip>
                );
              })}
              {line && polyline && (
                <svg
                  aria-hidden
                  viewBox={`0 0 1000 ${HEIGHT}`}
                  preserveAspectRatio='none'
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
                >
                  <polyline
                    points={polyline}
                    fill='none'
                    stroke={line.color}
                    strokeWidth={2.5}
                    strokeLinejoin='round'
                    strokeLinecap='round'
                    vectorEffect='non-scaling-stroke'
                  />
                </svg>
              )}
            </Box>

            <Box style={{ display: 'flex', gap: 4 }} mt={5}>
              {growth.map((point) => (
                <Text key={point.year} size='xs' c='dimmed' ta='center' style={{ flex: 1, minWidth: 12 }}>
                  {point.year}
                </Text>
              ))}
            </Box>
          </Box>
        </Box>
      </Group>

      <Group gap='md' mt='xs' wrap='wrap'>
        <Text size='xs' c='dimmed'>{description}</Text>
        {line && (
          <Group gap={6} ml='auto' wrap='nowrap'>
            <Box aria-hidden style={{ width: 18, height: 2, background: line.color }} />
            <Text size='xs' c='dimmed'>{line.label}</Text>
          </Group>
        )}
      </Group>
    </Card>
  );
}

/** A chart's card while its counts are on the way: the same box, so the page does not jump. */
export function YearBarChartSkeleton() {
  return (
    <Card aria-hidden>
      <Group gap='xs' mb='md' wrap='nowrap'>
        <Skeleton height={20} width='40%' radius='sm' />
        <Skeleton height={14} width={80} radius='sm' ml='auto' />
      </Group>
      <Skeleton height={HEIGHT + 22} radius='sm' />
      <Skeleton height={12} width='55%' radius='sm' mt='sm' />
    </Card>
  );
}
