import { BarChart, ChartTooltip, LineChart, type LineChartProps, PieChart } from '@mantine/charts';
import { Box, Group, Text } from '@mantine/core';
import { STATS_COLORS } from '../Stats/palette.ts';

const HEIGHT = 220;
/** The line or bars: the app's accent. */
const COLOR = 'marine.4';
/** Pie slices, in order: the Stats page's colour-blind-safe set, then the rest of Okabe–Ito. */
const SLICES = [
  STATS_COLORS.engagements,
  STATS_COLORS.marriages,
  STATS_COLORS.births,
  STATS_COLORS.deaths,
  '#f0e442',
  '#0072b2',
  '#d55e00',
  '#999999',
];
/** More points than this and a dot on each is a smear. */
const DOTS_UP_TO = 40;

const DATE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?$/;
const numbers = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const format = (value: number) => numbers.format(value);
const withUnit = (unit: string | undefined) => (value: number) => unit ? `${format(value)} ${unit}` : format(value);
const day = (time: number) => new Date(time).toISOString().slice(0, 10);

/** What a `Chart` draws: labelled values, in order. */
export type ChartSpec = {
  kind: 'line' | 'bar' | 'pie';
  title?: string;
  /** What the values are measured in: shown beside the title and in the tooltip. */
  unit?: string;
  points: { label: string; value: number }[];
};

/**
 * A small chart of labelled values: a line over time, bars to compare, or a pie of a whole —
 * `@mantine/charts`, which the shell keeps to itself, behind a shape a module can hand over.
 *
 * A line whose every label is a date is spaced by time, not evenly: a weight log with a gap of a year
 * should show the gap.
 */
export function Chart({ chart }: { chart: ChartSpec }) {
  const { kind, title, unit, points } = chart;
  // The unit goes in the tooltip and beside the title; on every axis tick it wraps and crowds the axis.
  const valueFormatter = withUnit(unit);
  const name = title ?? unit ?? 'value';
  const series = [{ name, color: COLOR }];
  const summary = `${title ? `${title}: ` : ''}${points.map((point) => `${point.label} ${valueFormatter(point.value)}`).join(', ')}`;
  const dated = kind === 'line' && points.every((point) => DATE.test(point.label));
  const tooltipProps: LineChartProps['tooltipProps'] = {
    content: ({ label, payload }) => (
      <ChartTooltip
        label={dated && typeof label === 'number' ? day(label) : String(label ?? '')}
        payload={payload}
        series={series}
        valueFormatter={valueFormatter}
      />
    ),
  };

  let body;
  if (kind === 'pie') {
    body = (
      <PieChart
        h={HEIGHT}
        size={HEIGHT - 40}
        data={points.map((point, index) => ({ name: point.label, value: point.value, color: SLICES[index % SLICES.length] }))}
        withTooltip
        tooltipDataSource='segment'
        withLegend
        valueFormatter={valueFormatter}
        strokeColor='var(--mantine-color-body)'
      />
    );
  } else if (dated) {
    const data = points.map((point) => ({ time: Date.parse(point.label.replace(' ', 'T') + (point.label.length > 10 ? 'Z' : '')), [name]: point.value }));
    body = (
      <LineChart
        h={HEIGHT}
        data={data}
        dataKey='time'
        series={series}
        curveType='linear'
        withDots={points.length <= DOTS_UP_TO}
        valueFormatter={format}
        xAxisProps={{ type: 'number', scale: 'time', domain: ['dataMin', 'dataMax'], tickFormatter: (time: number) => day(time) }}
        yAxisProps={{ domain: ['auto', 'auto'] }}
        tooltipProps={tooltipProps}
      />
    );
  } else {
    const data = points.map((point) => ({ label: point.label, [name]: point.value }));
    const Plot = kind === 'line' ? LineChart : BarChart;
    body = (
      <Plot
        h={HEIGHT}
        data={data}
        dataKey='label'
        series={series}
        valueFormatter={format}
        tooltipProps={tooltipProps}
        {...(kind === 'line' ? { curveType: 'linear' as const, withDots: points.length <= DOTS_UP_TO, yAxisProps: { domain: ['auto', 'auto'] } } : {})}
      />
    );
  }

  return (
    <Box className='mrx-chart' role='img' aria-label={summary}>
      {(title || unit) && (
        <Group gap={6} mb={6} wrap='nowrap'>
          {title && <Text size='sm' fw={500}>{title}</Text>}
          {unit && kind !== 'pie' && <Text size='xs' c='dimmed'>{unit}</Text>}
        </Group>
      )}
      {body}
    </Box>
  );
}
