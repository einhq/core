import { Alert, Anchor, Button, Card, Group, Stack, Switch, Text, Title } from '@mantine/core';
import { IconCurrentLocation, IconLock, IconWalk } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { agoText } from '../../lib/device-format.ts';
import { appTracking, appTrackingAllow, appTrackingSend, appTrackingSet, type EinAppTracking, type EinAppTrackingChange } from '../../lib/ein-app.ts';
import { notify } from '../../signals/notify.ts';

/** How often the card reads the reports' state while it is in view. */
const POLL_MS = 5_000;

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const ACTIVITY: Record<string, string> = { still: 'still', walking: 'walking', running: 'running', on_bicycle: 'cycling', in_vehicle: 'in a vehicle' };

/** The line that says what the reports do now. */
function stateText(tracking: EinAppTracking): string {
  if (!tracking.running) return tracking.access === 'none' ? 'Waiting until the app may know where the phone is' : 'Not running';
  if (tracking.still) return 'Paused while the phone lies still';
  return tracking.activity && tracking.activity !== 'still'
    ? `Following the phone as it moves (${ACTIVITY[tracking.activity] ?? tracking.activity})`
    : 'Following the phone as it moves';
}

/**
 * The App page's position reports: the app adds the phone's position to its device's `position`
 * track as it moves, by itself and also while it is closed, with what the app may know, whether it
 * asks for the precise position, and how the reports go.
 */
export function AppTracking({ device }: { device: string }) {
  const [tracking, setTracking] = useState<EinAppTracking>();
  const [failed, setFailed] = useState<string>();
  const [busy, setBusy] = useState(false);

  const read = useCallback(() =>
    appTracking().then((state) => {
      setTracking(state);
      setFailed(undefined);
    }, (error) => setFailed(messageOf(error))), []);

  useEffect(() => {
    void read();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void read();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [read]);

  const act = async (call: () => Promise<EinAppTracking>) => {
    setBusy(true);
    try {
      setTracking(await call());
    } catch (error) {
      notify({ message: messageOf(error), color: 'red' });
    } finally {
      setBusy(false);
    }
  };
  const change = (patch: EinAppTrackingChange) => act(() => appTrackingSet(patch));
  /** Turning it on asks for the position all the time when the app may not know it so yet. */
  const turnOn = () =>
    act(async () => {
      const state = await appTrackingSet({ enabled: true });
      return state.access !== 'always' || !state.motion ? await appTrackingAllow() : state;
    });

  if (failed && !tracking) return <Alert color='red' title='The app did not answer about the position reports'>{failed}</Alert>;
  if (!tracking) return null;

  const allow = (label: string) => <Button size='xs' variant='default' loading={busy} onClick={() => void act(appTrackingAllow)}>{label}</Button>;
  return (
    <Card withBorder maw={560}>
      <Stack gap='md'>
        <Group gap='xs'>
          <IconCurrentLocation size={18} />
          <Title order={4}>Position reports</Title>
        </Group>
        <Text size='sm' c='dimmed'>
          The app adds where the phone is to the Position track of <Anchor component={Link} to={`/devices/${encodeURIComponent(device)}`} size='sm'>{device}</Anchor>{' '}
          as it moves, also while the app is closed. It pauses while the phone lies still, and keeps the positions while it is offline.
        </Text>

        {tracking.access === 'none' && (
          <Alert color='yellow' icon={<IconLock size={16} />} title='The app may not know where the phone is'>
            <Stack gap='xs' align='flex-start'>
              <Text size='sm'>It needs the phone's position to report it.</Text>
              {allow('Allow location')}
            </Stack>
          </Alert>
        )}
        {tracking.access === 'in-use' && (
          <Alert color='yellow' icon={<IconLock size={16} />}>
            <Stack gap='xs' align='flex-start'>
              <Text size='sm'>
                The app may know the phone's position only while it is in use. Reports go on once you close the app, but not after the phone restarts.
              </Text>
              {allow('Allow all the time')}
            </Stack>
          </Alert>
        )}
        {tracking.approximate && (
          <Alert color='yellow' icon={<IconCurrentLocation size={16} />}>
            <Stack gap='xs' align='flex-start'>
              <Text size='sm'>The phone gives the app only its approximate position, which is too rough to report.</Text>
              {allow('Allow precise location')}
            </Stack>
          </Alert>
        )}
        {tracking.access !== 'none' && !tracking.motion && (
          <Alert color='yellow' icon={<IconWalk size={16} />}>
            <Stack gap='xs' align='flex-start'>
              <Text size='sm'>The app may not tell when the phone moves, so it goes on asking where it is while it lies still, which uses more battery.</Text>
              {allow('Allow')}
            </Stack>
          </Alert>
        )}

        <Switch
          label='Report this phone’s position'
          checked={tracking.enabled}
          disabled={busy}
          onChange={(event) => void (event.currentTarget.checked ? turnOn() : change({ enabled: false }))}
        />
        <Switch
          label='Precise position'
          description='The phone’s GPS: a better track, but more battery'
          checked={tracking.precise}
          disabled={busy}
          onChange={(event) => void change({ precise: event.currentTarget.checked })}
        />

        {tracking.enabled && (
          <Stack gap={6}>
            <Text size='sm'>{stateText(tracking)}</Text>
            <Text size='xs' c='dimmed'>
              Last position {agoText(tracking.lastFix)}
              {tracking.accuracy !== undefined && ` (within ${Math.round(tracking.accuracy)} m)`} · sent {agoText(tracking.lastSent)}
              {tracking.queued > 0 && ` · ${tracking.queued} waiting${tracking.waitingFor === 'network' ? ' for a connection' : ''}`}
            </Text>
            {tracking.lastError && <Text size='xs' c='red'>{tracking.lastError}</Text>}
            {tracking.queued > 0 && (
              <Group>
                <Button size='xs' variant='default' disabled={busy} onClick={() => void act(appTrackingSend)}>Send now</Button>
              </Group>
            )}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
