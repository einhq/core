import { Alert, Box, Container, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useSignals } from '@preact/signals-react/runtime';
import { EntityDetailHeader, FileStorageGrowth, NodeTypeGrowth, RoutePanel } from '@ein/ui/components';
import { YearBarChartSkeleton } from '../components/Stats/YearBarChart.tsx';
import { useStatsOverview } from '@ein/ui/hooks';
import { panelRoute, panelsOf } from '@ein/ui/signals';

/**
 * Core's own statistics — how the node types grew — after the sections modules give
 * (`stats.sections` panels: archive's life events), each a module route drawn here. The sections
 * load on their own, so they draw at once; the node charts stand as skeletons until the count,
 * which takes a few seconds on a large archive, is in.
 */
export default function StatsPage() {
  useSignals();
  const { data, loading, error } = useStatsOverview();
  const files = data?.nodeTypes.find((nodeType) => nodeType.type === 'file');

  return (
    <Box>
      <EntityDetailHeader
        title='Statistics'
        pattern='mixed'
        subtitle={
          <Text size='sm' c='gray.2'>
            Archive statistics over time
          </Text>
        }
        flowContent
      />

      <Container px='md' py='lg'>
        <Stack gap='lg'>
          {error && (
            <Alert color='red' variant='light' icon={<IconAlertTriangle size={16} />}>
              {error.message}
            </Alert>
          )}

          <Stack gap='xl'>
            {panelsOf('stats.sections').map((panel) => (
              <Stack key={panel.id} gap='md'>
                <Title order={2}>{panel.label}</Title>
                <RoutePanel path={panelRoute(panel)} />
              </Stack>
            ))}

            <Stack gap='md'>
              <Title order={2}>Nodes</Title>
              {loading && !data && (
                <SimpleGrid cols={{ base: 1, xl: 2 }} spacing='lg'>
                  <Box style={{ gridColumn: '1 / -1' }}>
                    <YearBarChartSkeleton />
                  </Box>
                  {[0, 1, 2, 3].map((i) => <YearBarChartSkeleton key={i} />)}
                </SimpleGrid>
              )}
              {data && (data.nodeTypes.length === 0 ? <Text c='dimmed'>No node history found</Text> : (
                <SimpleGrid cols={{ base: 1, xl: 2 }} spacing='lg'>
                  {files && (
                    <Box style={{ gridColumn: '1 / -1' }}>
                      <FileStorageGrowth files={files} />
                    </Box>
                  )}
                  {data.nodeTypes.map((nodeType) => <NodeTypeGrowth key={nodeType.type} nodeType={nodeType} />)}
                </SimpleGrid>
              ))}
            </Stack>
          </Stack>
        </Stack>
      </Container>
    </Box>
  );
}
