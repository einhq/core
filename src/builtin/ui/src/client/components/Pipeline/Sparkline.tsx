import { Box, Text, Tooltip } from '@mantine/core';
import { useMemo } from 'react';
import { SERIES_ACCENT } from './palette.ts';

export type Bucket = { at: number; count: number };

type Props = {
  buckets: Bucket[];
  /** Bucket width in ms, so empty stretches of time stay empty. */
  bucketMs: number;
  /** Window to draw, ending now. */
  windowMs: number;
  height?: number;
};

const timeLabel = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Completions over time — a single series, so it needs no legend; the heading
 * above it names what it is.
 *
 * Gaps are drawn as gaps: the aggregate returns only buckets that have
 * completions, and filling the run of missing buckets with zeroes is the
 * difference between "nothing finished for an hour" and "the chart skipped an
 * hour".
 */
export function Sparkline({ buckets, bucketMs, windowMs, height = 44 }: Props) {
  const series = useMemo(() => {
    const now = Date.now();
    const start = Math.floor((now - windowMs) / bucketMs) * bucketMs;
    const slots = Math.max(1, Math.round(windowMs / bucketMs));

    const counts = new Map<number, number>();
    for (const bucket of buckets) counts.set(Math.floor(bucket.at / bucketMs) * bucketMs, bucket.count);

    return Array.from({ length: slots }, (_, i) => {
      const at = start + i * bucketMs;
      return { at, count: counts.get(at) ?? 0 };
    });
  }, [buckets, bucketMs, windowMs]);

  const peak = Math.max(1, ...series.map((slot) => slot.count));

  return (
    <Box>
      <Box style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height }} role='img' aria-label={`Completions per ${Math.round(bucketMs / 60000)} minutes`}>
        {series.map((slot) => (
          <Tooltip key={slot.at} label={`${timeLabel(slot.at)} — ${slot.count} completed`} withArrow openDelay={0}>
            <Box
              style={{
                flex: 1,
                // A zero slot keeps a hairline so the bar row reads as a
                // timeline rather than a ragged set of floating columns, and
                // so the empty stretch is still hoverable.
                height: slot.count === 0 ? 1 : Math.max(2, (slot.count / peak) * height),
                background: slot.count === 0 ? 'var(--mrx-surface-overlay)' : SERIES_ACCENT,
                borderRadius: '2px 2px 0 0',
                minWidth: 1,
              }}
            />
          </Tooltip>
        ))}
      </Box>
      <Box style={{ display: 'flex', justifyContent: 'space-between' }} mt={4}>
        <Text size='xs' c='dimmed'>{timeLabel(series[0]?.at ?? Date.now())}</Text>
        <Text size='xs' c='dimmed'>now</Text>
      </Box>
    </Box>
  );
}
