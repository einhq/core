import { Alert, Anchor, Badge, Box, Button, Container, Group, SegmentedControl, Select, SimpleGrid, Stack, Table, Tabs, Text, TextInput } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { type DeviceHistory, type DeviceInfo, DEVICES_GROUPNAME, type EndpointSummary, type GroupEntry } from '@ein/api';
import { Chart, EmptyState, EntityDetailHeader, PageLoader, RoutePanel, TablerIcon } from '@ein/ui/components';
import { useAccessIds, useCommand, usePolledCommand } from '@ein/ui/hooks';
import { shq } from '@ein/ui/lib';
import { execCommand, notify, type PanelEntry, panelRoute, panelsOf } from '@ein/ui/signals';
import { DeviceKey } from '../components/Devices/DeviceKey.tsx';
import { EndpointTile } from '../components/Devices/EndpointTile.tsx';
import { FixMap } from '../components/Devices/FixMap.tsx';
import { agoText, chartLabel, readingText } from '../lib/device-format.ts';

/** The page's own tabs; a module's are `device.tabs` panels, drawn after Info. */
const TABS = ['overview', 'history', 'info'] as const;

/** The spans the History tab offers, each with the interval its values are summed up per. */
const SPANS = {
  day: { since: '1d', bucket: '15m', label: 'Day' },
  week: { since: '7d', bucket: '2h', label: 'Week' },
  month: { since: '30d', bucket: '6h', label: 'Month' },
  year: { since: '365d', bucket: '1d', label: 'Year' },
} as const;
type Span = keyof typeof SPANS;

/** The most fixes the History tab draws of a span: the latest. */
const FIX_LIMIT = 20_000;

const failed = (error: unknown) => notify({ message: error instanceof Error ? error.message : String(error), color: 'red' });

/** The modules' tabs for this device: a panel whose `when.has` names an endpoint type shows only on a device with such an endpoint. */
const deviceTabs = (info: DeviceInfo): PanelEntry[] =>
  panelsOf('device.tabs').filter((panel) => !panel.when?.has || info.endpointList.some((endpoint) => endpoint.type === panel.when?.has));

function Overview({ info, onChanged, onHistory }: { info: DeviceInfo; onChanged: () => void; onHistory: (endpoint: string) => void }) {
  const live = info.endpointList.filter((endpoint) => !endpoint.retired);
  const shown = live.filter((endpoint) => !endpoint.category);
  const other = live.filter((endpoint) => endpoint.category);
  if (live.length === 0) {
    return <EmptyState title='No endpoints'>The device has nothing it reports or can be told yet.</EmptyState>;
  }
  const tile = (endpoint: EndpointSummary) => <EndpointTile key={endpoint.name} device={info.name} endpoint={endpoint} onChanged={onChanged} onHistory={onHistory} />;
  return (
    <Stack gap='lg'>
      <SimpleGrid cols={{ base: 1, xs: 2, md: 3, lg: 4 }}>{shown.map(tile)}</SimpleGrid>
      {other.length > 0 && (
        <>
          <Text size='sm' c='dimmed'>About the device itself</Text>
          <SimpleGrid cols={{ base: 1, xs: 2, md: 3, lg: 4 }}>{other.map(tile)}</SimpleGrid>
        </>
      )}
    </Stack>
  );
}

/** Whether an endpoint has a history the History tab can draw: a track's fixes, or values a line can chart. */
const charted = (endpoint: EndpointSummary): boolean => {
  if (endpoint.type === 'track') return true;
  if (endpoint.type === 'control') return endpoint.schema?.type === 'bool' || endpoint.schema?.type === 'number';
  return endpoint.events === true || typeof endpoint.last?.value !== 'string';
};

/** What an endpoint's chart is measured in: an event log's count, a state's share of the time it was on. */
const chartUnit = (endpoint: EndpointSummary): string | undefined =>
  endpoint.events ? 'events' : endpoint.schema?.type === 'bool' || typeof endpoint.last?.value === 'boolean' ? 'share on' : endpoint.unit;

/**
 * An endpoint's history over a span: a log's or control's values summed up per interval (the
 * average of a value, the share of time on of a state, the count of an event log's events) as a
 * line, or a track's fixes on a map. The endpoint is in the URL (`?endpoint=`), so the Overview's
 * track can open its own; the device's main value is shown first.
 */
function History({ info }: { info: DeviceInfo }) {
  const [params, setParams] = useSearchParams();
  const choices = info.endpointList.filter(charted);
  const asked = choices.find((endpoint) => endpoint.name === params.get('endpoint'));
  const chosen = asked ?? choices.find((endpoint) => endpoint.name === info.main?.endpoint) ?? choices[0];
  const [span, setSpan] = useState<Span>('day');
  if (!chosen) return <EmptyState title='Nothing kept over time'>The device has no values, states or positions kept over time.</EmptyState>;
  const choose = (name: string | null) => {
    if (!name) return;
    const next = new URLSearchParams(params);
    next.set('endpoint', name);
    setParams(next, { replace: true });
  };
  return (
    <Stack gap='md'>
      <Group>
        <Select
          data={choices.map((endpoint) => ({ value: endpoint.name, label: endpoint.retired ? `${endpoint.label} (retired)` : endpoint.label }))}
          value={chosen.name}
          onChange={choose}
          allowDeselect={false}
          w={240}
          aria-label='Endpoint'
        />
        <SegmentedControl value={span} onChange={(next) => setSpan(next as Span)} data={Object.entries(SPANS).map(([value, { label }]) => ({ value, label }))} />
      </Group>
      {chosen.type === 'track' ? <FixHistory device={info.name} endpoint={chosen} span={span} /> : <ValueHistory device={info.name} endpoint={chosen} span={span} />}
    </Stack>
  );
}

function ValueHistory({ device, endpoint, span }: { device: string; endpoint: EndpointSummary; span: Span }) {
  const { since, bucket } = SPANS[span];
  const { data, loading, error } = useCommand<DeviceHistory>(
    `device-history ${shq(`${device}/${endpoint.name}`)} --since ${since} --bucket ${bucket} --agg ${endpoint.events ? 'count' : 'avg'} -n 2000`,
  );
  // The span chosen before stays drawn until this one's is in; another endpoint's answer is not drawn as this one's.
  const history = data?.endpoint === endpoint.name ? data : undefined;
  if (error) return <Alert color='red'>{error.message}</Alert>;
  if (!history) return loading ? <PageLoader /> : null;
  const points = history.readings.flatMap((reading) => typeof reading.value === 'number' ? [{ label: chartLabel(reading.at), value: reading.value }] : []);
  return points.length > 0 ? <Chart chart={{ kind: 'line', title: endpoint.label, unit: chartUnit(endpoint), points }} /> : <Text c='dimmed'>No values in this span.</Text>;
}

function FixHistory({ device, endpoint, span }: { device: string; endpoint: EndpointSummary; span: Span }) {
  const { data, loading, error } = useCommand<DeviceHistory>(`device-history ${shq(`${device}/${endpoint.name}`)} --since ${SPANS[span].since} -n ${FIX_LIMIT}`);
  const history = data?.endpoint === endpoint.name ? data : undefined;
  if (error) return <Alert color='red'>{error.message}</Alert>;
  if (!history) return loading ? <PageLoader /> : null;
  const fixes = history.fixes ?? [];
  if (fixes.length === 0) return <Text c='dimmed'>No fixes in this span.</Text>;
  return (
    <Stack gap='xs'>
      <Box style={{ borderRadius: 'var(--mantine-radius-md)', overflow: 'hidden' }}>
        <FixMap fixes={fixes} height='min(65vh, 640px)' />
      </Box>
      <Text size='sm' c='dimmed'>
        {fixes.length >= FIX_LIMIT
          ? `The latest ${fixes.length.toLocaleString()} fixes of the span`
          : `${fixes.length.toLocaleString()} ${fixes.length === 1 ? 'fix' : 'fixes'}`}, the last {agoText(fixes[fixes.length - 1].at)}
      </Text>
    </Stack>
  );
}

/**
 * Whether the reader may make, name and forget devices: an administrator, or a member of the
 * `devices` group. Only what to offer; the commands decide.
 */
function useDevicesMember(): boolean {
  const access = useAccessIds();
  const { data: groups } = useCommand<GroupEntry[]>('group-list');
  if (access?.admin === true) return true;
  const gid = groups?.find((group) => group.groupname === DEVICES_GROUPNAME)?.gid;
  return gid !== undefined && access !== null && access.gids.includes(gid);
}

/** A kept value as a row of the endpoint table says it: a track's fixes, else its latest value. */
const latestText = (endpoint: EndpointSummary): string =>
  endpoint.track ? `${endpoint.track.points.toLocaleString()} ${endpoint.track.points === 1 ? 'fix' : 'fixes'}` : readingText(endpoint.last?.value, endpoint.unit);

function Info({ info, onChanged }: { info: DeviceInfo; onChanged: () => void }) {
  const navigate = useNavigate();
  const member = useDevicesMember();
  const [label, setLabel] = useState(info.label);
  const rename = async () => {
    try {
      await execCommand(`device-label ${shq(info.name)} ${shq(label.trim())}`);
      onChanged();
    } catch (error) {
      failed(error);
    }
  };
  const forget = async () => {
    if (!globalThis.confirm(`Forget ${info.label} and all it has kept? A driver that finds it again makes it again.`)) return;
    try {
      await execCommand(`device-forget ${shq(info.name)}`);
      navigate('/devices');
    } catch (error) {
      failed(error);
    }
  };
  const driver = info.driver ? `${info.driver}${info.driverRunning === false ? ' (not running)' : ''}` : undefined;
  const rows: [string, string | undefined][] = [
    ['Name', info.name],
    ['Class', info.class],
    ['Driver', driver],
    ['Manufacturer', info.manufacturer],
    ['Model', info.model],
    ['Firmware', info.firmware],
    ['Serial', info.serial],
    ['MAC', info.mac],
  ];
  return (
    <Stack gap='lg' maw={860}>
      <Table>
        <Table.Tbody>
          {rows.filter(([, value]) => value).map(([name, value]) => (
            <Table.Tr key={name}>
              <Table.Td c='dimmed' w={160}>{name}</Table.Td>
              <Table.Td c={name === 'Driver' && info.driverRunning === false ? 'red' : undefined}>{value}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Table.ScrollContainer minWidth={560}>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Endpoint</Table.Th>
              <Table.Th>Type</Table.Th>
              <Table.Th>Unit</Table.Th>
              <Table.Th>Latest</Table.Th>
              <Table.Th>Writable</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {info.endpointList.map((endpoint) => (
              <Table.Tr key={endpoint.name}>
                <Table.Td>
                  {endpoint.label} <Text span size='xs' c='dimmed'>{endpoint.name}</Text>
                </Table.Td>
                <Table.Td>
                  {endpoint.type}
                  {endpoint.events && <Badge ml='xs' size='xs' variant='light'>events</Badge>}
                  {endpoint.category && <Badge ml='xs' size='xs' variant='light' color='gray'>{endpoint.category}</Badge>}
                  {!endpoint.supported && <Badge ml='xs' size='xs' variant='light' color='yellow'>not read</Badge>}
                  {endpoint.retired && <Badge ml='xs' size='xs' variant='light' color='gray'>retired</Badge>}
                </Table.Td>
                <Table.Td>{endpoint.unit ?? ''}</Table.Td>
                <Table.Td>{latestText(endpoint)}</Table.Td>
                <Table.Td>{endpoint.writable ? 'yes' : 'no'}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {info.input && (
        <Box>
          <Text fw={500} mb='xs'>Device key</Text>
          <DeviceKey device={info.name} driver={info.driver} />
        </Box>
      )}
      {member && (
        <Group align='end'>
          <TextInput label='Called' value={label} onChange={(event) => setLabel(event.currentTarget.value)} w={280} />
          <Button variant='light' onClick={rename} disabled={!label.trim() || label.trim() === info.label}>Rename</Button>
          <Button variant='subtle' color='red' onClick={forget} leftSection={<TablerIcon name='trash' size={16} />}>Forget</Button>
        </Group>
      )}
    </Stack>
  );
}

/**
 * A device under `/dev`: its endpoints as they are now (Overview), their history (History), what it
 * is and who may write it (Info), and the tabs modules give it (`device.tabs` panels, each drawing
 * its route with the device's path for `{path}`). The tab is in the URL (`?tab=`).
 */
export default function DevicePage() {
  useSignals();
  const { name = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const { data: info, loading, error, refetch } = usePolledCommand<DeviceInfo>(`device-show ${shq(name)}`);
  const refresh = () => void refetch();

  if (loading && !info) return <PageLoader />;
  if (!info) {
    return (
      <Container py='xl'>
        <Anchor component={Link} to='/devices'>← Devices</Anchor>
        <Alert mt='md' color='red'>{error?.message ?? `No device ${name}`}</Alert>
      </Container>
    );
  }

  const panels = deviceTabs(info);
  const asked = params.get('tab');
  const tab = (TABS as readonly (string | null)[]).includes(asked) || panels.some((panel) => panel.id === asked) ? asked! : 'overview';
  const openHistory = (endpoint: string) => setParams({ tab: 'history', endpoint });

  return (
    <Tabs value={tab} onChange={(next) => setParams({ tab: next ?? 'overview' })} keepMounted={false}>
      <EntityDetailHeader
        title={info.label}
        pattern='device'
        flowContent
        actions={{ share: info.path }}
        subtitle={[info.manufacturer, info.model].filter(Boolean).join(' ') || undefined}
        meta={
          <Group gap='xs'>
            {info.online === true && <Badge variant='light' color='green'>online</Badge>}
            {info.online === false && <Badge variant='light' color='red'>offline</Badge>}
            {info.class && <Badge variant='light' color='orange'>{info.class}</Badge>}
            {info.lastAt && <Text size='sm' c='dimmed'>last value {agoText(info.lastAt)}</Text>}
          </Group>
        }
        tabs={
          <Tabs.List>
            <Tabs.Tab value='overview'>Overview</Tabs.Tab>
            <Tabs.Tab value='history'>History</Tabs.Tab>
            <Tabs.Tab value='info'>Info</Tabs.Tab>
            {panels.map((panel) => (
              <Tabs.Tab key={panel.id} value={panel.id} leftSection={panel.icon ? <TablerIcon name={panel.icon} size={16} /> : undefined}>{panel.label}</Tabs.Tab>
            ))}
          </Tabs.List>
        }
      />
      <Container size='xl' py='md' px='md'>
        <Tabs.Panel value='overview'>
          <Overview info={info} onChanged={refresh} onHistory={openHistory} />
        </Tabs.Panel>
        <Tabs.Panel value='history'>
          <History info={info} />
        </Tabs.Panel>
        <Tabs.Panel value='info'>
          <Info info={info} onChanged={refresh} />
        </Tabs.Panel>
        {panels.map((panel) => (
          <Tabs.Panel key={panel.id} value={panel.id}>
            <RoutePanel path={panelRoute(panel, info.path)} />
          </Tabs.Panel>
        ))}
      </Container>
    </Tabs>
  );
}
