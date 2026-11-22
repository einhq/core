import { Alert, Button, Card, Checkbox, Group, Progress, Stack, Switch, Text, Title } from '@mantine/core';
import { IconCloudUpload, IconLock, IconMapPin } from '@tabler/icons-react';
import { useSignals } from '@preact/signals-react/runtime';
import { useCallback, useEffect, useState } from 'react';
import { agoText } from '../../lib/device-format.ts';
import { appBackup, appBackupAllow, appBackupNow, appBackupSet, type EinAppBackup, type EinAppBackupChange } from '../../lib/ein-app.ts';
import { formatBytes } from '../../lib/format.ts';
import { panelRoute, panelsOf } from '../../signals/nav.ts';
import { notify } from '../../signals/notify.ts';
import { RoutePanel } from '../Surface/SurfaceRouter.tsx';

/** How often the card reads the backup's state while it is in view: often enough to follow a file being sent. */
const POLL_MS = 2_000;

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const WAITING_FOR = { wifi: 'Waiting for Wi-Fi', charging: 'Waiting until the phone charges', network: 'Waiting for a connection' } as const;

/** The line that says how far the backup is. */
function progressText(backup: EinAppBackup): string {
  if (backup.current) return `Sending ${backup.current.name}`;
  if (backup.running) return 'Looking for new photos and videos';
  if (backup.enabled && backup.waitingFor && backup.waiting > 0) return WAITING_FOR[backup.waitingFor];
  if (backup.waiting > 0) return `${backup.waiting} not sent yet`;
  return 'Everything chosen is sent';
}

/**
 * The App page's photo backup: the app sends the photos and videos of the phone's folders chosen
 * here into a folder of the paired account's, by itself, with what it may read, the conditions it
 * sends under and how far it is. Where it sends is a module's to offer (`app.backup` panels), since
 * only a module knows where a phone's photos belong; without one the backup cannot be turned on.
 */
export function AppBackup() {
  useSignals();
  const [backup, setBackup] = useState<EinAppBackup>();
  const [failed, setFailed] = useState<string>();
  const [busy, setBusy] = useState(false);
  const destinations = panelsOf('app.backup');

  const read = useCallback(() =>
    appBackup().then((state) => {
      setBackup(state);
      setFailed(undefined);
    }, (error) => setFailed(messageOf(error))), []);

  useEffect(() => {
    void read();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void read();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [read]);

  const act = async (call: () => Promise<EinAppBackup>) => {
    setBusy(true);
    try {
      setBackup(await call());
    } catch (error) {
      notify({ message: messageOf(error), color: 'red' });
    } finally {
      setBusy(false);
    }
  };
  const change = (patch: EinAppBackupChange) => act(() => appBackupSet(patch));
  /** Turning it on asks for what it may not read yet. */
  const turnOn = () =>
    act(async () => {
      const state = await appBackupSet({ enabled: true });
      return state.access === 'none' || !state.location ? await appBackupAllow() : state;
    });

  if (failed && !backup) return <Alert color='red' title='The app did not answer about the backup'>{failed}</Alert>;
  if (!backup) return null;

  const canRead = backup.access !== 'none';
  const current = backup.current;
  return (
    <Card withBorder maw={560}>
      <Stack gap='md'>
        <Group gap='xs'>
          <IconCloudUpload size={18} />
          <Title order={4}>Photo backup</Title>
        </Group>
        <Text size='sm' c='dimmed'>
          The app sends the new photos and videos of the folders you choose by itself, and never deletes anything, here or on the phone.
        </Text>

        {!canRead && (
          <Alert color='yellow' icon={<IconLock size={16} />} title='The app may not see your photos'>
            <Stack gap='xs' align='flex-start'>
              <Text size='sm'>It needs to read your photos and videos to send them.</Text>
              <Button size='xs' loading={busy} onClick={() => void act(appBackupAllow)}>Allow access</Button>
            </Stack>
          </Alert>
        )}
        {backup.access === 'partial' && (
          <Alert color='yellow' icon={<IconLock size={16} />}>
            <Stack gap='xs' align='flex-start'>
              <Text size='sm'>You let the app see only some of your photos and videos, so it sends only those. Allow all to back up every new one.</Text>
              <Button size='xs' variant='default' loading={busy} onClick={() => void act(appBackupAllow)}>Allow all</Button>
            </Stack>
          </Alert>
        )}
        {canRead && !backup.location && (
          <Alert color='yellow' icon={<IconMapPin size={16} />}>
            <Stack gap='xs' align='flex-start'>
              <Text size='sm'>The app may not read where photos were taken, so the phone takes the place out of every photo it sends.</Text>
              <Button size='xs' variant='default' loading={busy} onClick={() => void act(appBackupAllow)}>Allow</Button>
            </Stack>
          </Alert>
        )}

        {destinations.length > 0
          ? destinations.map((panel) => <RoutePanel key={panel.id} path={panelRoute(panel)} />)
          : <Text size='sm' c='dimmed'>Nothing on this EiN gives a phone a folder to back up into yet: that comes with a module.</Text>}

        <Switch
          label='Back up photos and videos'
          description={backup.into ? `Into ${backup.into.label}` : 'Choose where they go first'}
          checked={backup.enabled}
          disabled={busy || (!backup.enabled && !backup.into)}
          onChange={(event) => void (event.currentTarget.checked ? turnOn() : change({ enabled: false }))}
        />

        {canRead && (
          <Stack gap={6}>
            <Text size='sm' fw={500}>Folders</Text>
            {backup.folders.length === 0 && <Text size='sm' c='dimmed'>The phone has no photos or videos the app may see.</Text>}
            {backup.folders.map((folder) => (
              <Checkbox
                key={folder.path}
                label={folder.name}
                description={`${folder.path} · ${folder.count}`}
                checked={folder.chosen}
                disabled={busy}
                onChange={(event) => {
                  const others = backup.folders.filter((each) => each.chosen && each.path !== folder.path).map((each) => each.path);
                  void change({ folders: event.currentTarget.checked ? [...others, folder.path] : others });
                }}
              />
            ))}
          </Stack>
        )}

        <Stack gap={6}>
          <Switch label='Only on Wi-Fi' checked={backup.wifiOnly} disabled={busy} onChange={(event) => void change({ wifiOnly: event.currentTarget.checked })} />
          <Switch label='Only while charging' checked={backup.chargingOnly} disabled={busy} onChange={(event) => void change({ chargingOnly: event.currentTarget.checked })} />
        </Stack>

        {backup.enabled && (
          <Stack gap={6}>
            <Text size='sm'>{progressText(backup)}</Text>
            {current && (
              <>
                <Progress value={current.size > 0 ? (100 * current.sent) / current.size : 100} size='sm' />
                <Text size='xs' c='dimmed'>{formatBytes(current.sent)} of {formatBytes(current.size)}</Text>
              </>
            )}
            <Text size='xs' c='dimmed'>
              {backup.sent} sent, {backup.waiting} to go · last backup {agoText(backup.lastRun)}
            </Text>
            {backup.lastError && <Text size='xs' c='red'>{backup.lastError}</Text>}
            <Group>
              <Button size='xs' variant='default' disabled={busy || backup.running} onClick={() => void act(appBackupNow)}>Back up now</Button>
            </Group>
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
