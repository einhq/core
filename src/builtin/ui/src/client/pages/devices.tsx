import { Alert, Badge, Box, Stack } from '@mantine/core';
import {
  BrowseEntityCard,
  CardGrid,
  EmptyState,
  EntityCard,
  EntityDetailHeader,
  HeaderChoice,
  HeaderChoices,
  HeaderFilterBar,
  HeaderStats,
  ListFilterInput,
  PageLoader,
  RoutePanel,
  TablerIcon,
} from '@ein/ui/components';
import { countOf, matchesText } from '@ein/ui/lib';
import { usePersistedState, usePolledCommand, useUrlParam } from '@ein/ui/hooks';
import { panelRoute, panelsOf } from '@ein/ui/signals';
import type { DeviceSummary } from '@ein/api';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { readingText } from '../lib/device-format.ts';

type Scope = 'all' | 'online';
type DeviceSort = 'name' | 'recent';

/** What a card says under a device's name: its main value, else what it is. */
const descriptionOf = (device: DeviceSummary): string =>
  device.main ? `${device.main.label}: ${readingText(device.main.value, device.main.unit)}` : [device.manufacturer, device.model].filter(Boolean).join(' ');

/** A frame of a camera's smallest stream, for its card; the page polls `devices`, which keeps it current enough. */
const pictureUrl = (device: DeviceSummary, at: string): string | undefined =>
  device.picture ? `/file/dev/${encodeURIComponent(device.name)}/${encodeURIComponent(device.picture)}?at=${at}` : undefined;

/**
 * Every device under `/dev` the reader may see, as cards: online or not, its main value, and a
 * camera's picture. The
 * header carries the modules' `devices.header` panels, beside the filters: automation's devices
 * found on the network.
 */
export default function DevicesPage() {
  const [search, setSearch] = useUrlParam('q');
  const [scope, setScope] = usePersistedState<Scope>('devices.list.scope', 'all');
  const [sortBy, setSortBy] = usePersistedState<DeviceSort>('devices.list.sort', 'name');
  const { data, loading, error } = usePolledCommand<DeviceSummary[]>('devices');
  const devices = useMemo(() => data ?? [], [data]);
  // A new frame each time the list is read again.
  const readAt = useMemo(() => String(Date.now()), [data]);
  const navigate = useNavigate();

  const shown = useMemo(() => {
    const matching = devices.filter((device) =>
      (scope === 'all' || device.online === true) &&
      matchesText([device.label, device.name, device.class, device.model, device.manufacturer], search)
    );
    if (sortBy === 'recent') return matching.toSorted((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
    return matching.toSorted((a, b) => a.label.localeCompare(b.label));
  }, [devices, scope, search, sortBy]);
  const online = devices.filter((device) => device.online === true).length;

  return (
    <Box>
      <EntityDetailHeader
        title='Devices'
        pattern='device'
        meta={!loading && <HeaderStats items={[countOf(devices.length, 'device', 'devices'), `${online} online`]} />}
        flowContent
        controls={
          <HeaderFilterBar input={<ListFilterInput value={search} onChange={setSearch} what='devices' />}>
            {panelsOf('devices.header').map((panel) => <RoutePanel key={panel.id} path={panelRoute(panel)} loading={null} failed={null} />)}
            <HeaderChoices>
              <HeaderChoice
                label='Show'
                variant='segmented'
                value={scope}
                onChange={(next) => setScope(next as Scope)}
                options={[
                  { label: 'All', value: 'all', icon: <TablerIcon name='plug' size={18} /> },
                  { label: 'Online', value: 'online', icon: <TablerIcon name='wifi' size={18} /> },
                ]}
              />
              <HeaderChoice
                label='Sort'
                value={sortBy}
                onChange={(next) => setSortBy(next as DeviceSort)}
                options={[
                  { value: 'name', label: 'Name (A-Z)', icon: <TablerIcon name='sort-ascending-letters' size={18} /> },
                  { value: 'recent', label: 'Latest value', icon: <TablerIcon name='clock' size={18} /> },
                ]}
              />
            </HeaderChoices>
          </HeaderFilterBar>
        }
      />

      <Box px='md' py='lg'>
        <Stack gap='lg'>
          {error && <Alert icon={<TablerIcon name='alert-circle' size={16} />} color='red'>{error.message}</Alert>}
          {loading && !data ? <PageLoader /> : (
            <>
              <CardGrid items={shown} itemKey={(device) => device.name} textParts={(device) => ({ description: Boolean(descriptionOf(device)), badges: true })}>
                {(device) => {
                  const card = {
                    title: device.label,
                    description: descriptionOf(device),
                    kind: 'device',
                    onClick: () => navigate(`/devices/${encodeURIComponent(device.name)}`),
                    badges: (
                      <>
                        {device.online === true && <Badge size='xs' variant='light' color='green'>online</Badge>}
                        {device.online === false && <Badge size='xs' variant='light' color='red'>offline</Badge>}
                        {device.class && <Badge size='xs' variant='light' color='orange'>{device.class}</Badge>}
                        <Badge size='xs' variant='light' color='gray'>{countOf(device.endpoints, 'endpoint', 'endpoints')}</Badge>
                      </>
                    ),
                  } as const;
                  return device.picture ? <EntityCard {...card} coverUrl={pictureUrl(device, readAt)} /> : <BrowseEntityCard {...card} />;
                }}
              </CardGrid>
              {devices.length === 0 && (
                <EmptyState title='No devices yet'>
                  Devices appear here when a driver finds them, or when someone makes one with device-create.
                </EmptyState>
              )}
            </>
          )}
        </Stack>
      </Box>
    </Box>
  );
}
