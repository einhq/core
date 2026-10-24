import { Box, Card, Divider, Flex, Group, Skeleton, Stack, Text, Title, Tooltip } from '@mantine/core';
import { type Bucket, SERIES_ACCENT, Sparkline, type Workload, WorkloadBar } from '../Pipeline/mod.ts';

type Props = {
  /** Every instance by state; undefined while loading. */
  counts?: Workload;
  /** Cancelled instances, apart from the failed ones. */
  cancelled?: number;
  /** All instances, whatever their state. */
  total?: number;
  /** Completed instances per bucket, as `pipeline-overview` aggregates them. */
  completions: Bucket[];
  bucketMs: number;
  windowMs: number;
};

const CHART_HEIGHT = 64;

/**
 * The pipeline work on one card: how fast it finishes — the last hour and the last day as
 * figures beside the day's completions over time — and, underneath, where every instance stands.
 *
 * The figures wear the chart's accent dot, as a `StatTile` does its sparkline's, so the number and
 * the bars read as one mark. The rate goes beside the chart rather than in the bar's legend: it is
 * a rate, not a share, and the stacked bar can only carry shares.
 */
export function WorkSummary({ counts, cancelled, total, completions, bucketMs, windowMs }: Props) {
  const now = Date.now();
  const since = (ms: number) => completions.filter((bucket) => bucket.at >= now - ms).reduce((sum, bucket) => sum + bucket.count, 0);
  const lastHour = since(3600_000);
  const lastDay = since(windowMs);
  const loading = counts === undefined;

  return (
    <Card>
      <Group justify='space-between' mb='md'>
        <Title order={4}>Work</Title>
        {!loading && <Text size='sm' c='dimmed'>{(total ?? 0).toLocaleString()} instances</Text>}
      </Group>

      <Flex direction={{ base: 'column', sm: 'row' }} gap='lg' align={{ base: 'stretch', sm: 'flex-end' }}>
        <Stack gap={2} miw={170}>
          <Group gap={6} wrap='nowrap'>
            <Box w={8} h={8} style={{ borderRadius: 2, background: SERIES_ACCENT, flexShrink: 0 }} />
            <Text size='xs' c='dimmed'>Completed per hour</Text>
          </Group>
          {loading ? <Skeleton height={30} width='60%' my={2} /> : (
            <Tooltip label='Instances completed in the last hour' withArrow position='top-start'>
              <Text fz={32} fw={600} lh={1.1} w='fit-content'>{lastHour.toLocaleString()}</Text>
            </Tooltip>
          )}
          <Text size='xs' c='dimmed'>
            {loading ? ' ' : `${lastDay.toLocaleString()} in the last ${Math.round(windowMs / 3600_000)} hours`}
          </Text>
        </Stack>

        <Box style={{ flex: 1, minWidth: 0 }}>
          {loading ? <Skeleton height={CHART_HEIGHT + 20} /> : <Sparkline buckets={completions} bucketMs={bucketMs} windowMs={windowMs} height={CHART_HEIGHT} />}
        </Box>
      </Flex>

      <Divider my='md' />

      <Text size='xs' c='dimmed' mb={6}>Instances by state</Text>
      {loading ? <Skeleton height={14} /> : <WorkloadBar counts={counts} cancelled={cancelled ?? 0} height={14} />}
    </Card>
  );
}
