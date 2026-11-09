import { ActionIcon, Anchor, Box, Button, Card, Group, NumberInput, Select, Skeleton, Slider, Stack, Switch, Text, TextInput } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useEffect, useState } from 'react';
import type { ControlSchema, DeviceHistory, DeviceValue, EndpointSummary } from '@ein/api';
import { StatTile } from '../Pipeline/StatTile.tsx';
import { TablerIcon } from '../Icon/TablerIcon.tsx';
import { Dialog } from '../Surface/Dialog.tsx';
import { formatDateTime, formatTime } from '../../lib/datetime.ts';
import { agoText, readingText, sameValue } from '../../lib/device-format.ts';
import { shq } from '../../lib/shquote.ts';
import { execCommand } from '../../signals/shell-client.ts';
import { notify } from '../../signals/notify.ts';
import { FixMap } from './FixMap.tsx';

type Fix = NonNullable<DeviceHistory['fixes']>[number];

const failed = (error: unknown) => notify({ message: error instanceof Error ? error.message : String(error), color: 'red' });

type TileProps = {
  /** The device's name. */
  device: string;
  /** What the device is (`boat`, `car`, …): a boat's speed is in knots. */
  deviceClass?: string;
  endpoint: EndpointSummary;
  /** After a control was written: the page reads the device again. */
  onChanged: () => void;
  /** Open the History tab at this endpoint. */
  onHistory: (endpoint: string) => void;
};

/**
 * One endpoint on a device's Overview: a log's value with its last six hours, an event log's last
 * event, a track's last day on a small map, or a control to switch, set or press.
 */
export function EndpointTile(props: TileProps) {
  const { endpoint } = props;
  if (endpoint.type === 'track') return <TrackTile {...props} />;
  if (endpoint.type === 'control') return <ControlTile {...props} />;
  if (endpoint.events) {
    return (
      <StatTile
        label={endpoint.label}
        value={endpoint.last ? readingText(endpoint.last.value) : '–'}
        hint={endpoint.last ? `pressed ${agoText(endpoint.last.at)}` : 'not pressed yet'}
        icon={<TablerIcon name='hand-click' size={18} />}
      />
    );
  }
  return <LogTile {...props} />;
}

/** The last six hours of a numeric log, ten minutes to a bar, read again when a new value arrives. */
function useSparkline(device: string, endpoint: EndpointSummary): { at: number; value: number }[] | undefined {
  const [series, setSeries] = useState<{ at: number; value: number }[]>();
  const numeric = typeof endpoint.last?.value === 'number';
  useEffect(() => {
    if (!numeric) return;
    let cancelled = false;
    execCommand<DeviceHistory>(`device-history ${shq(`${device}/${endpoint.name}`)} --since 6h --bucket 10m`)
      .then((history) => {
        if (cancelled) return;
        setSeries(history.readings.flatMap((reading) => typeof reading.value === 'number' ? [{ at: Date.parse(reading.at), value: reading.value }] : []));
      })
      .catch(() => !cancelled && setSeries(undefined));
    return () => {
      cancelled = true;
    };
  }, [device, endpoint.name, endpoint.last?.at, numeric]);
  return series;
}

function LogTile({ device, endpoint }: TileProps) {
  const series = useSparkline(device, endpoint);
  return (
    <StatTile
      label={endpoint.label}
      value={readingText(endpoint.last?.value, endpoint.unit)}
      hint={endpoint.last ? agoText(endpoint.last.at) : endpoint.supported ? 'no value yet' : 'not read'}
      series={series}
      seriesMax={series?.length ? Math.max(...series.map((point) => point.value)) : undefined}
      seriesUnit={endpoint.unit ? ` ${endpoint.unit}` : ''}
    />
  );
}

/** The day of fixes up to a track's last: what it did today while it reports, its last trip once it stopped. */
function useLastDay(device: string, endpoint: EndpointSummary): Fix[] | undefined {
  const [fixes, setFixes] = useState<Fix[]>();
  const lastAt = endpoint.track?.lastAt;
  useEffect(() => {
    if (!lastAt) return;
    let cancelled = false;
    const since = new Date(Date.parse(lastAt) - 86_400_000).toISOString();
    execCommand<DeviceHistory>(`device-history ${shq(`${device}/${endpoint.name}`)} --since ${shq(since)} -n 5000`)
      .then((history) => !cancelled && setFixes(history.fixes ?? []))
      .catch(() => !cancelled && setFixes([]));
    return () => {
      cancelled = true;
    };
  }, [device, endpoint.name, lastAt]);
  return fixes;
}

/** A coordinate in degrees with its hemisphere: `59.32741° N`. */
const degreesText = (value: number, positive: string, negative: string): string => `${Math.abs(value).toFixed(5)}° ${value < 0 ? negative : positive}`;

/** A time as the tile shows it: the hour and minute today, the date as well before (`9 Nov 2026, 20:30`). */
const fixTimeText = (at: string): string =>
  new Date(at).toDateString() === new Date().toDateString()
    ? formatTime(at, { hour: '2-digit', minute: '2-digit' })
    : formatDateTime(at, { dateStyle: 'medium', timeStyle: 'short' });

/** What a fix tells beyond where it is: altitude, speed (knots on a boat, km/h otherwise) and course. */
const motionText = (fix: Fix, deviceClass?: string): string =>
  [
    fix.alt !== undefined ? `${Math.round(fix.alt)} m` : undefined,
    fix.speed !== undefined ? (deviceClass === 'boat' ? `${(fix.speed * 3600 / 1852).toFixed(1)} kn` : `${Math.round(fix.speed * 3.6)} km/h`) : undefined,
    fix.course !== undefined ? `${Math.round(fix.course)}°` : undefined,
  ].filter(Boolean).join(' · ');

function TrackTile({ device, deviceClass, endpoint, onHistory }: TileProps) {
  const fixes = useLastDay(device, endpoint);
  const points = endpoint.track?.points ?? 0;
  const last = fixes?.at(-1);
  const motion = last ? motionText(last, deviceClass) : '';
  const [mapOpen, setMapOpen] = useState(false);
  const isNarrow = useMediaQuery('(max-width: 48em)', false, { getInitialValueInEffect: false });
  const isCoarse = useMediaQuery('(hover: none) and (pointer: coarse)', false, { getInitialValueInEffect: false });
  const isMobile = isNarrow || isCoarse;
  return (
    <Card p='sm'>
      <Stack gap={6}>
        <Text size='xs' c='dimmed' truncate>{endpoint.label}</Text>
        {points === 0
          ? <Text size='sm' c='dimmed'>No fixes yet.</Text>
          : fixes && fixes.length > 0
          ? (
            <Box style={{ position: 'relative', borderRadius: 'var(--mantine-radius-sm)', overflow: 'hidden' }}>
              <FixMap fixes={fixes} height={180} layerSwitcher={false} />
              <ActionIcon
                variant='filled'
                color='dark'
                size={44}
                onClick={() => setMapOpen(true)}
                aria-label='Enlarge map'
                title='Enlarge map'
                style={{ position: 'absolute', top: '50%', right: 8, zIndex: 1, transform: 'translateY(-50%)' }}
              >
                <TablerIcon name='maximize' size={22} />
              </ActionIcon>
            </Box>
          )
          : <Skeleton height={180} animate={fixes === undefined} />}
        {last && (
          <Box>
            <Text size='sm' fw={600}>{degreesText(last.lat, 'N', 'S')}, {degreesText(last.lng, 'E', 'W')}</Text>
            {motion && <Text size='sm'>{motion}</Text>}
          </Box>
        )}
        <Group justify='space-between' gap='xs' wrap='nowrap'>
          <Text size='xs' c='dimmed'>
            {endpoint.track?.lastAt ? `${fixTimeText(endpoint.track.lastAt)}, ${agoText(endpoint.track.lastAt)}` : ''}
          </Text>
          {points > 0 && (
            <Anchor component='button' size='xs' onClick={() => onHistory(endpoint.name)}>
              Over time
            </Anchor>
          )}
        </Group>
      </Stack>
      <Dialog
        opened={mapOpen && !!fixes?.length}
        onClose={() => setMapOpen(false)}
        fullScreen={isMobile}
        size='min(1000px, calc(100vw - 32px))'
        title={endpoint.label}
        subtitle={endpoint.track?.lastAt ? `${fixTimeText(endpoint.track.lastAt)}, ${agoText(endpoint.track.lastAt)}` : undefined}
        icon='map-pin'
        pattern='device'
        bleed
      >
        {fixes && fixes.length > 0 && (
          <Box style={{ flex: isMobile ? 1 : undefined, height: isMobile ? undefined : 'min(70dvh, 700px)', minHeight: 320 }}>
            <FixMap fixes={fixes} height='100%' />
          </Box>
        )}
      </Dialog>
    </Card>
  );
}

/**
 * Whether a control's last write is still on its way: the device has reported neither the value
 * asked for nor anything since it was asked.
 */
const waiting = (endpoint: EndpointSummary): boolean => {
  const { requested, last } = endpoint;
  if (!requested || endpoint.schema?.type === 'momentary') return false;
  if (!last) return true;
  return !sameValue(last.value, requested.value) && Date.parse(last.at) < Date.parse(requested.at);
};

function ControlTile({ endpoint, onChanged }: TileProps) {
  const [busy, setBusy] = useState(false);
  const schema: ControlSchema = endpoint.schema ?? { type: 'text' };
  const pending = waiting(endpoint);
  // While a write is on its way the control shows what was asked, so it does not jump back.
  const shown = pending ? endpoint.requested?.value : endpoint.last?.value;
  const disabled = !endpoint.writable || busy;

  const write = async (value: string) => {
    setBusy(true);
    try {
      await execCommand(`echo ${shq(value)} > ${shq(endpoint.path)}`);
      onChanged();
    } catch (error) {
      failed(error);
    } finally {
      setBusy(false);
    }
  };

  const hint = pending && endpoint.requested
    ? `asked ${readingText(endpoint.requested.value, endpoint.unit)}, waiting for the device`
    : schema.type === 'momentary'
    ? endpoint.requested ? `pressed ${agoText(endpoint.requested.at)} by ${endpoint.requested.by}` : 'not pressed yet'
    : endpoint.last
    ? agoText(endpoint.last.at)
    : 'nothing reported yet';

  return (
    <Card p='sm'>
      <Stack gap={8}>
        <Group justify='space-between' wrap='nowrap' align='flex-start'>
          <Box style={{ minWidth: 0 }}>
            <Text size='xs' c='dimmed' truncate>{endpoint.label}</Text>
            <Text size='xs' c={pending ? 'yellow' : 'dimmed'}>{hint}</Text>
          </Box>
          {schema.type === 'bool' && (
            <Switch
              size='lg'
              checked={shown === true}
              disabled={disabled}
              onChange={(event) => write(event.currentTarget.checked ? 'on' : 'off')}
              aria-label={endpoint.label}
            />
          )}
        </Group>
        {schema.type === 'number' && <NumberControl schema={schema} shown={shown} unit={endpoint.unit} label={endpoint.label} disabled={disabled} onSet={write} />}
        {schema.type === 'enum' && (
          <Select
            data={schema.options}
            value={typeof shown === 'string' ? shown : null}
            onChange={(next) => next && write(next)}
            allowDeselect={false}
            disabled={disabled}
            aria-label={endpoint.label}
          />
        )}
        {schema.type === 'text' && <TextControl shown={shown} label={endpoint.label} disabled={disabled} onSet={write} />}
        {schema.type === 'momentary' && (
          <Button
            size='compact-sm'
            variant='light'
            loading={busy}
            disabled={!endpoint.writable}
            onClick={() => write('press')}
            style={{ alignSelf: 'flex-start' }}
          >
            Press
          </Button>
        )}
      </Stack>
    </Card>
  );
}

type NumberSchema = Extract<ControlSchema, { type: 'number' }>;

/**
 * A number to set: a slider between its least and greatest, written when let go, or a field
 * written with Set when it has no range.
 */
function NumberControl({ schema, shown, unit, label, disabled, onSet }: {
  schema: NumberSchema;
  shown: DeviceValue | undefined;
  unit?: string;
  label: string;
  disabled: boolean;
  onSet: (value: string) => void;
}) {
  const current = typeof shown === 'number' ? shown : typeof shown === 'string' && shown.trim() !== '' && Number.isFinite(Number(shown)) ? Number(shown) : undefined;
  const [draft, setDraft] = useState<number | undefined>(current);
  useEffect(() => setDraft(current), [current]);

  if (schema.min !== undefined && schema.max !== undefined) {
    const step = schema.step ?? (schema.max - schema.min) / 100;
    return (
      <Group gap='sm' wrap='nowrap'>
        <Slider
          style={{ flex: 1 }}
          min={schema.min}
          max={schema.max}
          step={step}
          value={draft ?? schema.min}
          onChange={setDraft}
          onChangeEnd={(value) => onSet(String(Number(value.toPrecision(10))))}
          label={(value) => readingText(value, unit)}
          disabled={disabled}
          thumbLabel={label}
        />
        <Text size='sm' w={72} ta='right'>{readingText(draft, unit)}</Text>
      </Group>
    );
  }
  return (
    <Group gap='xs' wrap='nowrap'>
      <NumberInput
        style={{ flex: 1 }}
        size='xs'
        min={schema.min}
        max={schema.max}
        step={schema.step}
        value={draft ?? ''}
        onChange={(value) => setDraft(typeof value === 'number' ? value : undefined)}
        onKeyDown={(event) => event.key === 'Enter' && draft !== undefined && onSet(String(draft))}
        rightSection={unit ? <Text size='xs' c='dimmed'>{unit}</Text> : undefined}
        disabled={disabled}
        aria-label={label}
      />
      <Button size='xs' variant='light' disabled={disabled || draft === undefined || draft === current} onClick={() => draft !== undefined && onSet(String(draft))}>
        Set
      </Button>
    </Group>
  );
}

/** A line of text to set, written with Set or Enter. */
function TextControl({ shown, label, disabled, onSet }: { shown: DeviceValue | undefined; label: string; disabled: boolean; onSet: (value: string) => void }) {
  const current = shown === undefined || shown === null ? '' : String(shown);
  const [draft, setDraft] = useState(current);
  useEffect(() => setDraft(current), [current]);
  const changed = draft.trim() !== '' && draft !== current;
  return (
    <Group gap='xs' wrap='nowrap'>
      <TextInput
        style={{ flex: 1 }}
        size='xs'
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => event.key === 'Enter' && changed && onSet(draft)}
        disabled={disabled}
        aria-label={label}
      />
      <Button size='xs' variant='light' disabled={disabled || !changed} onClick={() => onSet(draft)}>Set</Button>
    </Group>
  );
}
