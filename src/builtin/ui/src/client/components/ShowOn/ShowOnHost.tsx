import { ActionIcon, Button, Group, Stack, Text, Tooltip } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import type { DeviceSummary } from '@ein/api';
import { useEffect, useState } from 'react';
import { notify } from '../../signals/notify.ts';
import { closeShowOn, loadShowOnDevices, showOn, showOnDevices, type ShowOnTarget, showOnTarget, stopShowing } from '../../signals/show-on.ts';
import { TablerIcon } from '../Icon/TablerIcon.tsx';
import { Dialog } from '../Surface/Dialog.tsx';

/** Why a device refused, without the device's name (and control) core puts first, since the label is said already. */
const failed = (device: DeviceSummary, error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = [`${device.name}/show: `, `${device.name}/stop: `, `${device.name}: `].find((each) => message.startsWith(each));
  return prefix ? message.slice(prefix.length) : message;
};

/** One screen or speaker: give it what is open, or stop what it shows; one that does not answer is listed greyed, offering neither. */
function DeviceRow({ device, target, onShown }: { device: DeviceSummary; target: ShowOnTarget; onShown: () => void }) {
  const [busy, setBusy] = useState<'show' | 'stop' | null>(null);
  const offline = device.online === false;

  const show = async () => {
    setBusy('show');
    try {
      const answer = await showOn(device, target);
      notify({ message: `${device.label}: ${answer.message ?? `showing ${target.title}`}` });
      onShown();
    } catch (error) {
      notify({ message: `${device.label}: ${failed(device, error)}`, color: 'red' });
    } finally {
      setBusy(null);
    }
  };

  const stop = async () => {
    setBusy('stop');
    try {
      await stopShowing(device);
      notify({ message: `${device.label}: stopped` });
    } catch (error) {
      notify({ message: `${device.label}: ${failed(device, error)}`, color: 'red' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Group gap='xs' wrap='nowrap'>
      <Button
        variant='default'
        flex={1}
        justify='flex-start'
        leftSection={<TablerIcon name={device.class === 'speaker' ? 'device-speaker' : 'device-tv'} size={18} />}
        rightSection={offline ? <Text size='xs' c='dimmed'>offline</Text> : undefined}
        loading={busy === 'show'}
        disabled={offline || busy !== null}
        onClick={() => void show()}
      >
        {device.label}
      </Button>
      <Tooltip label={`Stop ${device.label}`}>
        <ActionIcon
          variant='default'
          size='lg'
          aria-label={`Stop ${device.label}`}
          loading={busy === 'stop'}
          disabled={offline || busy !== null}
          onClick={() => void stop()}
        >
          <TablerIcon name='player-stop' size={18} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}

/**
 * The one "Show on" dialog, mounted at the app root: the screens and speakers the user may write
 * to, each given what was open when it was asked for (`openShowOn`), or stopped. A screen near the
 * browser has a button of its own (`useShowNearby`).
 */
export function ShowOnHost() {
  useSignals();
  const target = showOnTarget.value;
  const [shown, setShown] = useState<ShowOnTarget | null>(null);
  if (target && target !== shown) setShown(target);
  const devices = showOnDevices.value ?? [];

  useEffect(() => {
    if (target) void loadShowOnDevices(true);
  }, [target]);

  if (!shown) return null;

  return (
    <Dialog opened={target !== null} onClose={closeShowOn} title={`Show “${shown.title}” on`} icon='device-tv' size='sm' floating>
      <Stack gap='xs'>
        {devices.length === 0 && <Text c='dimmed'>No screen or speaker you may show on.</Text>}
        {devices.map((device) => <DeviceRow key={device.name} device={device} target={shown} onShown={closeShowOn} />)}
      </Stack>
    </Dialog>
  );
}
