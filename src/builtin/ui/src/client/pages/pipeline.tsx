import { Anchor, Badge, Box, Button, Card, Checkbox, Container, Group, Stack, Table, Tabs, Text, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconPlayerStop, IconRefresh, IconTrash } from '@tabler/icons-react';
import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Dialog, DialogActions, elapsed, EntityDetailHeader, PageLoader, statusColor } from '@ein/ui/components';
import { countOf } from '@ein/ui/lib';
import { useAccessIds, usePipelineActions, usePipelineInstances, usePipelines } from '@ein/ui/hooks';

const STATUS_TABS = ['all', 'running', 'completed', 'failed', 'cancelled'] as const;

const formatTime = (ts?: number) => ts ? new Date(ts).toLocaleString() : '-';

export default function PipelineDetailPage() {
  const { pipeline } = useParams<{ pipeline: string }>();
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const { data: definitions } = usePipelines();
  const definition = definitions.find((def) => def.name === pipeline);

  const { data: instances, loading, hasMore, loadMore, loadingMore, refetch } = usePipelineInstances({
    pipeline,
    status: statusFilter === 'all' ? undefined : statusFilter,
  });
  const { rerun, cancel, remove, prune } = usePipelineActions();
  // Rerunning, cancelling, removing and pruning instances are the administrator's; anyone else
  // gets the list to read.
  const admin = useAccessIds()?.admin === true;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [removeOpen, removeModal] = useDisclosure(false);
  const [pruneOpen, pruneModal] = useDisclosure(false);

  const visibleIds = useMemo(() => new Set(instances.map((i) => i.id)), [instances]);
  const selectedIds = useMemo(() => [...selected].filter((id) => visibleIds.has(id)), [selected, visibleIds]);
  // Ids are only unique within a pipeline, so every action is sent qualified.
  const selectedRefs = useMemo(() => selectedIds.map((id) => `${pipeline}/${id}`), [selectedIds, pipeline]);
  const selectedLive = useMemo(
    () => instances.some((i) => selected.has(i.id) && (i.status === 'running' || i.status === 'queued')),
    [instances, selected],
  );

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) => (prev.size >= instances.length && instances.length > 0 ? new Set() : new Set(instances.map((i) => i.id))));
  }, [instances]);

  const clear = useCallback(() => setSelected(new Set()), []);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      clear();
      await refetch();
    } finally {
      setBusy(false);
    }
  }, [clear, refetch]);

  const allChecked = instances.length > 0 && selectedIds.length === instances.length;
  const someChecked = selectedIds.length > 0 && !allChecked;

  if (!pipeline) return <Text>Missing pipeline name</Text>;

  // The status filter narrows the one list below rather than switching panels, but it is this
  // page's only choice of view, so it stands on the header's edge like other pages' tabs.
  return (
    <Tabs value={statusFilter} onChange={(v) => setStatusFilter(v || 'all')}>
      <EntityDetailHeader
        title={pipeline}
        pattern='system'
        tabs={
          <Tabs.List>
            {STATUS_TABS.map((tab) => <Tabs.Tab key={tab} value={tab}>{tab.charAt(0).toUpperCase() + tab.slice(1)}</Tabs.Tab>)}
          </Tabs.List>
        }
        subtitle={definition?.description && <Text size='sm' c='gray.2'>{definition.description}</Text>}
        meta={
          <Anchor size='sm' c='gray.3' onClick={() => navigate('/system?tab=work')}>
            ← System dashboard
          </Anchor>
        }
        flowContent
      />

      <Container py='md' px='md'>
        <Stack gap='lg'>
          {definition && (
            <Card>
              <Group gap='xl'>
                <Box>
                  <Text size='xs' c='dimmed'>Trigger</Text>
                  {
                    /* triggerLabel names every kind of trigger; a fact-triggered
                    pipeline has no event or node type to show. */
                  }
                  <Badge variant='light' size='sm' mt={4}>{definition.triggerLabel ?? '-'}</Badge>
                </Box>
                <Box>
                  <Text size='xs' c='dimmed'>Steps</Text>
                  <Text size='sm' mt={4}>{definition.steps?.join(' → ') || '-'}</Text>
                </Box>
                {definition.options?.priority !== undefined && (
                  <Box>
                    <Text size='xs' c='dimmed'>Priority</Text>
                    <Text size='sm' mt={4}>{definition.options.priority}</Text>
                  </Box>
                )}
              </Group>
            </Card>
          )}

          <Card withBorder={admin}>
            <Group gap='xs' mb='md'>
              <Title order={4}>Instances</Title>
              {admin && (
                <Button
                  size='xs'
                  variant='light'
                  color='gray'
                  ml='auto'
                  leftSection={<IconTrash size={14} />}
                  onClick={pruneModal.open}
                  disabled={busy || instances.length === 0}
                >
                  Prune
                </Button>
              )}
            </Group>

            {admin && selectedIds.length > 0 && (
              <Group mb='sm' gap='xs'>
                <Text size='sm' fw={500}>{selectedIds.length} selected</Text>
                <Button size='xs' variant='light' leftSection={<IconRefresh size={14} />} onClick={() => run(() => rerun(selectedRefs))} loading={busy}>
                  Rerun
                </Button>
                <Button
                  size='xs'
                  variant='light'
                  color='orange'
                  leftSection={<IconPlayerStop size={14} />}
                  onClick={() => run(() => cancel(selectedRefs))}
                  loading={busy}
                  disabled={!selectedLive}
                >
                  Cancel
                </Button>
                <Button size='xs' variant='light' color='red' leftSection={<IconTrash size={14} />} onClick={removeModal.open} disabled={busy}>
                  Remove
                </Button>
                <Button size='xs' variant='subtle' color='gray' onClick={clear} disabled={busy}>Clear</Button>
              </Group>
            )}

            {instances.length === 0 ? (loading ? <PageLoader /> : <Text c='dimmed'>No instances</Text>) : (
              <>
                <Table striped highlightOnHover>
                  <Table.Thead>
                    <Table.Tr>
                      {admin && (
                        <Table.Th w={40}>
                          <Checkbox aria-label='Select all' checked={allChecked} indeterminate={someChecked} onChange={toggleAll} />
                        </Table.Th>
                      )}
                      <Table.Th>Status</Table.Th>
                      <Table.Th>Target</Table.Th>
                      <Table.Th>Started</Table.Th>
                      <Table.Th ta='right'>Duration</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {instances.map((instance) => (
                      <Table.Tr key={instance.id}>
                        {admin && (
                          <Table.Td onClick={(e) => e.stopPropagation()}>
                            <Checkbox
                              aria-label={`Select ${instance.id}`}
                              checked={selected.has(instance.id)}
                              onChange={() => toggle(instance.id)}
                            />
                          </Table.Td>
                        )}
                        <Table.Td style={{ cursor: 'pointer' }} onClick={() => navigate(`/system/pipelines/${encodeURIComponent(pipeline)}/${instance.id}`)}>
                          <Badge color={statusColor(instance.status)} variant='light' size='sm'>{instance.status}</Badge>
                        </Table.Td>
                        <Table.Td style={{ cursor: 'pointer' }} onClick={() => navigate(`/system/pipelines/${encodeURIComponent(pipeline)}/${instance.id}`)}>
                          <Text size='sm' truncate maw={400} title={instance.triggerPath}>{instance.triggerPath}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size='sm'>{formatTime(instance.startedAt)}</Text>
                        </Table.Td>
                        <Table.Td ta='right'>
                          <Text size='sm' c='dimmed'>{elapsed(instance.startedAt, instance.completedAt ?? Date.now())}</Text>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>

                {hasMore && (
                  <Group justify='center' mt='md'>
                    <Button size='xs' variant='light' onClick={loadMore} loading={loadingMore}>Load more</Button>
                  </Group>
                )}
              </>
            )}
          </Card>
        </Stack>

        <Dialog
          opened={removeOpen}
          onClose={removeModal.close}
          title={`Remove ${countOf(selectedIds.length, 'instance', 'instances')}?`}
          icon='trash'
          pattern='danger'
          size='sm'
          floating
        >
          <Text size='sm'>Running ones are cancelled first. This cannot be undone.</Text>
          <DialogActions>
            <Button variant='default' onClick={removeModal.close}>Cancel</Button>
            <Button
              color='red'
              onClick={() => {
                removeModal.close();
                return run(() => remove(selectedRefs));
              }}
            >
              Remove
            </Button>
          </DialogActions>
        </Dialog>

        <Dialog opened={pruneOpen} onClose={pruneModal.close} title='Prune instances?' icon='trash' pattern='danger' size='sm' floating>
          <Text size='sm'>
            {statusFilter === 'all'
              ? `Every completed and cancelled ${pipeline} instance is removed; failed ones stay, for the Failed tab to prune.`
              : `Every ${statusFilter} ${pipeline} instance is removed.`} This cannot be undone.
          </Text>
          <DialogActions>
            <Button variant='default' onClick={pruneModal.close}>Cancel</Button>
            <Button
              color='red'
              onClick={() => {
                pruneModal.close();
                return run(() => prune({ pipeline, status: statusFilter === 'all' ? undefined : statusFilter }));
              }}
            >
              Prune
            </Button>
          </DialogActions>
        </Dialog>
      </Container>
    </Tabs>
  );
}
