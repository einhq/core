/**
 * What `Chart` draws, as SVG in pixels: a line or bars over a value axis, and a pie. Only React,
 * so a test can render them without the theme.
 */
import type { PointerEvent } from 'react';
import { STATS_COLORS } from '../Stats/palette.ts';
import { axis, labelEvery } from './scale.ts';

const HEIGHT = 220;
/** The line or bars: the app's accent. */
export const COLOR = 'var(--mantine-color-marine-4)';
/** Pie slices, in order: the Stats page's colour-blind-safe set, then the rest of Okabe–Ito. */
export const SLICES = [
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
/** Room around the plot: the value axis's labels on the left, the labels' axis below. */
const MARGIN = { top: 8, right: 12, bottom: 24, left: 48 };
const AXIS_TEXT = { fontSize: 11, fill: 'var(--mantine-color-dimmed)' };
const GRID = 'var(--mantine-color-default-border)';
const EDGE = 'var(--mantine-color-body)';

const DATE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?$/;
const numbers = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
export const format = (value: number) => numbers.format(value);
const day = (time: number) => new Date(time).toISOString().slice(0, 10);
/** A date label's time: midnight UTC for a day, UTC for a day and a time, as `day` reads it back. */
const timeOf = (label: string) => Date.parse(label.replace(' ', 'T') + (label.length > 10 ? 'Z' : ''));

/** Whether every label is a date, so a line is spaced by time. */
export const allDates = (labels: string[]) => labels.every((label) => DATE.test(label));

type Point = { label: string; value: number };

/** The point under the pointer, and where its tooltip points, in pixels of the plot. */
export type Tip = { index: number; x: number; y: number };

export type PlotProps = { points: Point[]; width: number; active: number | undefined; onTip: (tip: Tip | null) => void };

/** A line or bars over a value axis, with the labels (or, for dates, the time) below. */
export function AxisPlot({ points, width, active, onTip, bars, dated }: PlotProps & { bars: boolean; dated: boolean }) {
  const plotWidth = Math.max(1, width - MARGIN.left - MARGIN.right);
  const bottom = HEIGHT - MARGIN.bottom;
  const values = axis(points.map((point) => point.value), { zero: bars });
  const yOf = (value: number) => MARGIN.top + (bottom - MARGIN.top) * (1 - (value - values.min) / (values.max - values.min));
  const band = plotWidth / points.length;

  let xs: number[];
  let ticks: { x: number; label: string }[];
  if (dated) {
    const times = points.map((point) => timeOf(point.label));
    const first = Math.min(...times);
    const last = Math.max(...times);
    const xOfTime = (time: number) => MARGIN.left + (last === first ? plotWidth / 2 : (plotWidth * (time - first)) / (last - first));
    xs = times.map(xOfTime);
    const count = last === first ? 1 : Math.min(5, Math.max(2, Math.floor(plotWidth / 90)));
    ticks = Array.from({ length: count }, (_, i) => first + (count === 1 ? 0 : ((last - first) * i) / (count - 1)))
      .map((time) => ({ x: xOfTime(time), label: day(time) }));
  } else {
    xs = points.map((_, i) => MARGIN.left + (bars ? band * (i + 0.5) : points.length === 1 ? plotWidth / 2 : (plotWidth * i) / (points.length - 1)));
    const every = labelEvery(points.map((point) => point.label), plotWidth);
    ticks = points.flatMap((point, i) => (i % every === 0 ? [{ x: xs[i], label: point.label }] : []));
  }

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
    let index = 0;
    xs.forEach((at, i) => {
      if (Math.abs(at - x) < Math.abs(xs[index] - x)) index = i;
    });
    onTip({ index, x: xs[index], y: yOf(bars ? Math.max(points[index].value, 0) : points[index].value) });
  };
  const barWidth = Math.min(48, Math.max(2, band * 0.7));

  return (
    <svg width={width} height={HEIGHT} style={{ display: 'block', overflow: 'visible' }} onPointerMove={onPointerMove} onPointerLeave={() => onTip(null)}>
      {values.ticks.map((value) => (
        <g key={value}>
          <line x1={MARGIN.left} x2={width - MARGIN.right} y1={yOf(value)} y2={yOf(value)} stroke={GRID} />
          <text x={MARGIN.left - 6} y={yOf(value)} dy='0.32em' textAnchor='end' {...AXIS_TEXT}>{format(value)}</text>
        </g>
      ))}
      {ticks.map((tick, i) => (
        <text
          key={i}
          x={tick.x}
          y={bottom + 16}
          // A time axis's first and last ticks sit on the plot's edges: their labels run inward.
          textAnchor={dated && ticks.length > 1 && i === 0 ? 'start' : dated && ticks.length > 1 && i === ticks.length - 1 ? 'end' : 'middle'}
          {...AXIS_TEXT}
        >
          {tick.label}
        </text>
      ))}
      {bars
        ? points.map((point, i) => (
          <rect
            key={i}
            x={xs[i] - barWidth / 2}
            y={yOf(Math.max(point.value, 0))}
            width={barWidth}
            height={Math.max(1, Math.abs(yOf(point.value) - yOf(0)))}
            rx={2}
            fill={COLOR}
            fillOpacity={active === undefined || active === i ? 1 : 0.7}
          />
        ))
        : (
          <>
            {active !== undefined && <line x1={xs[active]} x2={xs[active]} y1={MARGIN.top} y2={bottom} stroke={GRID} />}
            <polyline
              points={points.map((point, i) => `${xs[i]},${yOf(point.value)}`).join(' ')}
              fill='none'
              stroke={COLOR}
              strokeWidth={2}
              strokeLinejoin='round'
              strokeLinecap='round'
            />
            {points.length <= DOTS_UP_TO && points.map((point, i) => <circle key={i} cx={xs[i]} cy={yOf(point.value)} r={3} fill={COLOR} stroke={EDGE} />)}
            {active !== undefined && <circle cx={xs[active]} cy={yOf(points[active].value)} r={4.5} fill={COLOR} stroke={EDGE} strokeWidth={2} />}
          </>
        )}
    </svg>
  );
}

/** A pie of the points' shares of their sum; a value below zero has no share. */
export function PiePlot({ points, width, active, onTip }: PlotProps) {
  const radius = HEIGHT / 2 - 10;
  const cx = width / 2;
  const cy = HEIGHT / 2;
  const shares = points.map((point) => Math.max(0, point.value));
  const total = shares.reduce((sum, share) => sum + share, 0);
  const at = (turn: number) => [cx + radius * Math.sin(turn * 2 * Math.PI), cy - radius * Math.cos(turn * 2 * Math.PI)];

  const onPointerMove = (index: number) => (event: PointerEvent<SVGElement>) => {
    const box = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
    onTip({ index, x: event.clientX - box.left, y: event.clientY - box.top });
  };

  let start = 0;
  return (
    <svg width={width} height={HEIGHT} style={{ display: 'block' }} onPointerLeave={() => onTip(null)}>
      {total === 0 ? <circle cx={cx} cy={cy} r={radius} fill='var(--mrx-surface-overlay)' /> : shares.map((share, index) => {
        const turn = share / total;
        const from = start;
        start += turn;
        if (turn === 0) return null;
        const common = {
          fill: SLICES[index % SLICES.length],
          stroke: EDGE,
          fillOpacity: active === undefined || active === index ? 1 : 0.75,
          onPointerMove: onPointerMove(index),
        };
        // A whole pie is a circle: an arc from a point back to itself draws nothing.
        if (turn > 0.9999) return <circle key={index} cx={cx} cy={cy} r={radius} {...common} />;
        const [x0, y0] = at(from);
        const [x1, y1] = at(from + turn);
        return <path key={index} d={`M${cx},${cy} L${x0},${y0} A${radius},${radius} 0 ${turn > 0.5 ? 1 : 0} 1 ${x1},${y1} Z`} {...common} />;
      })}
    </svg>
  );
}
