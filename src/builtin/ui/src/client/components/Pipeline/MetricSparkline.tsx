import { Box, Text, Tooltip } from '@mantine/core';
import { SERIES_ACCENT } from './palette.ts';

export type MetricPoint = { at: number; value: number };

type Props = {
  points: MetricPoint[];
  height?: number;
  /** Fixed upper bound. Percentages pin to 100 so tiles are comparable. */
  max?: number;
  unit?: string;
  color?: string;
  /** Axis labels underneath. Off inside a stat tile, where space is the point. */
  axis?: boolean;
};

const DAY = 86_400_000;

const timeLabel = (at: number, span: number, detail = false) => {
  const date = new Date(at);
  if (span >= DAY) {
    const day = date.toLocaleDateString([], { day: 'numeric', month: 'short' });
    return detail ? `${day}, ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : day;
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

/**
 * A gauge over time — utilization, not a count.
 *
 * Separate from `Sparkline` because the two answer different questions and the
 * difference shows in the drawing. A count series must fill its missing buckets
 * with zeroes, since "nothing finished this hour" is a fact worth seeing. A
 * gauge has no such thing as a missing bucket: samples arrive on a fixed
 * cadence, and a gap means the sampler was down, which is not a reading of
 * zero. So this plots the samples it has, evenly spaced, and says nothing about
 * the ones it does not.
 *
 * Scaled against `max` rather than the observed peak: a CPU chart that
 * rescales to its own maximum makes 4% idle look identical to 95% saturated.
 */
export function MetricSparkline({ points, height = 40, max = 100, unit = '%', color = SERIES_ACCENT, axis = false }: Props) {
  if (points.length === 0) {
    return (
      <Box style={{ height }} display='flex'>
        <Text size='xs' c='dimmed' style={{ margin: 'auto' }}>no samples yet</Text>
      </Box>
    );
  }

  const ceiling = Math.max(max, ...points.map((point) => point.value));
  const span = points[points.length - 1].at - points[0].at;

  return (
    <Box>
      <Box
        style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height }}
        role='img'
        aria-label={`${points.length} samples, latest ${points[points.length - 1].value}${unit}`}
      >
        {points.map((point) => (
          <Tooltip key={point.at} label={`${timeLabel(point.at, span, true)} — ${point.value}${unit}`} withArrow openDelay={0}>
            <Box
              style={{
                flex: 1,
                // A true zero still draws a hairline, so the row reads as a
                // continuous timeline rather than a hole in the data.
                height: Math.max(1, (point.value / ceiling) * height),
                background: color,
                borderRadius: '2px 2px 0 0',
                minWidth: 1,
                cursor: 'default',
              }}
            />
          </Tooltip>
        ))}
      </Box>

      {axis && (
        <Box style={{ display: 'flex', justifyContent: 'space-between' }} mt={4}>
          <Text size='xs' c='dimmed'>{timeLabel(points[0].at, span)}</Text>
          <Text size='xs' c='dimmed'>now</Text>
        </Box>
      )}
    </Box>
  );
}
