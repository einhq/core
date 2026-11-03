import { Box, Group, Paper, Text } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { useState } from 'react';
import { allDates, AxisPlot, COLOR, format, PiePlot, type PlotProps, SLICES, type Tip } from './plots.tsx';

/** The width drawn at until the box is measured, and where nothing measures it. */
const FALLBACK_WIDTH = 480;

const withUnit = (unit: string | undefined) => (value: number) => unit ? `${format(value)} ${unit}` : format(value);

/** What a `Chart` draws: labelled values, in order. */
export type ChartSpec = {
  kind: 'line' | 'bar' | 'pie';
  title?: string;
  /** What the values are measured in: shown beside the title and in the tooltip. */
  unit?: string;
  points: { label: string; value: number }[];
};

/**
 * A small chart of labelled values: a line over time, bars to compare, or a pie of a whole, drawn
 * as SVG at the width of its box. Pointing at a point, bar or slice shows its label and value.
 *
 * A line whose every label is a date is spaced by time, not evenly: a weight log with a gap of a year
 * should show the gap. A line's value axis fits its values; bars stand on zero.
 */
export function Chart({ chart }: { chart: ChartSpec }) {
  const { kind, title, unit, points } = chart;
  const { ref, width: measured } = useElementSize();
  const width = measured || FALLBACK_WIDTH;
  const [tip, setTip] = useState<Tip | null>(null);
  // The unit goes in the tooltip and beside the title; on every axis tick it wraps and crowds the axis.
  const valueFormatter = withUnit(unit);
  const summary = `${title ? `${title}: ` : ''}${points.map((point) => `${point.label} ${valueFormatter(point.value)}`).join(', ')}`;
  const dated = kind === 'line' && allDates(points.map((point) => point.label));
  const props: PlotProps = { points, width, active: tip?.index, onTip: setTip };
  const active = tip ? points[tip.index] : undefined;

  return (
    <Box className='mrx-chart' role='img' aria-label={summary}>
      {(title || unit) && (
        <Group gap={6} mb={6} wrap='nowrap'>
          {title && <Text size='sm' fw={500}>{title}</Text>}
          {unit && kind !== 'pie' && <Text size='xs' c='dimmed'>{unit}</Text>}
        </Group>
      )}
      <Box ref={ref} pos='relative'>
        {points.length === 0
          ? <Text size='sm' c='dimmed'>Nothing to chart.</Text>
          : kind === 'pie'
          ? <PiePlot {...props} />
          : <AxisPlot {...props} bars={kind === 'bar'} dated={dated} />}
        {tip && active && (
          <ChartTip
            tip={tip}
            width={width}
            label={active.label}
            value={valueFormatter(active.value)}
            color={kind === 'pie' ? SLICES[tip.index % SLICES.length] : COLOR}
          />
        )}
      </Box>
      {kind === 'pie' && (
        <Group gap='sm' justify='center' mt={6}>
          {points.map((point, index) => (
            <Group key={index} gap={6} wrap='nowrap'>
              <Box aria-hidden w={10} h={10} style={{ borderRadius: 2, background: SLICES[index % SLICES.length] }} />
              <Text size='xs' c='dimmed'>{point.label}</Text>
            </Group>
          ))}
        </Group>
      )}
    </Box>
  );
}

/** A point's label and value, above where it points, or below when that is near the top. */
function ChartTip({ tip, width, label, value, color }: { tip: Tip; width: number; label: string; value: string; color: string }) {
  const below = tip.y < 56;
  return (
    <Paper
      shadow='md'
      withBorder
      px='xs'
      py={6}
      style={{
        position: 'absolute',
        left: Math.min(Math.max(tip.x, 64), width - 64),
        top: tip.y,
        transform: below ? 'translate(-50%, 12px)' : 'translate(-50%, calc(-100% - 12px))',
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
        zIndex: 1,
      }}
    >
      <Text size='xs' c='dimmed'>{label}</Text>
      <Group gap={6} wrap='nowrap'>
        <Box aria-hidden w={8} h={8} style={{ borderRadius: '50%', background: color }} />
        <Text size='sm' fw={500}>{value}</Text>
      </Group>
    </Paper>
  );
}
