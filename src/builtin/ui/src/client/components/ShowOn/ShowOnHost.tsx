import { ActionIcon, Button, Group, Stack, Text, Tooltip } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import type { DeviceSummary } from '@ein/api';
import { useEffect, useState } from 'react';
import { notify } from '../../signals/notify.ts';
import {
  chooseNearby,
  closeShowOn,
  loadShowOnDevices,
  nearbyShowing,
  offersNearby,
  showOn,
  showOnDevices,
  showOnNearby,
  showOnNearbyFiles,
  type ShowOnTarget,
  showOnTarget,
  stopNearby,
  stopShowing,
  streamNearby,
} from '../../signals/show-on.ts';
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
 * A screen near the browser, which EiN does not reach itself (a TV where a phone that reaches EiN
 * over the internet is): a page is rendered as live video, a recording or video made for the screen
 * to fetch, and the browser's own picker hands the address to the screen chosen there. That takes a
 * moment, after which a browser that no longer counts the tap as one asks for another.
 */
function NearbyRow({ target, onShown }: { target: ShowOnTarget; onShown: () => void }) {
  useSignals();
  const [busy, setBusy] = useState(false);
  const [choose, setChoose] = useState(false);
  const showing = nearbyShowing.value;

  const pick = async () => {
    setChoose(false);
    try {
      await chooseNearby();
      onShown();
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      const said = error instanceof Error ? error.message : String(error);
      // The tap no longer counts: ask for another.
      if (name === 'InvalidAccessError') setChoose(true);
      // The browser's own words tell one that finds no screen from one that offers this stream to none.
      else if (name === 'NotFoundError') notify({ message: `This browser finds no screen near you to show it on (${said})`, color: 'red' });
      // NotAllowedError is the picker dismissed.
      else if (name !== 'NotAllowedError') notify({ message: `A screen near you: ${said}`, color: 'red' });
    }
  };

  const show = async () => {
    setBusy(true);
    try {
      await streamNearby(target);
    } catch (error) {
      notify({ message: `A screen near you: ${error instanceof Error ? error.message : String(error)}`, color: 'red' });
      return;
    } finally {
      setBusy(false);
    }
    if (navigator.userActivation && !navigator.userActivation.isActive) setChoose(true);
    else await pick();
  };

  return (
    <Group gap='xs' wrap='nowrap'>
      <Button
        variant={choose ? 'filled' : 'default'}
        flex={1}
        justify='flex-start'
        leftSection={<TablerIcon name='cast' size={18} />}
        rightSection={showing ? <Text size='xs' c='dimmed' truncate>{showing}</Text> : undefined}
        loading={busy}
        onClick={() => void (choose ? pick() : show())}
      >
        {choose ? 'Choose the screen' : 'A screen near you'}
      </Button>
      <Tooltip label='Stop the screen near you'>
        <ActionIcon variant='default' size='lg' aria-label='Stop the screen near you' disabled={!showing} onClick={stopNearby}>
          <TablerIcon name='player-stop' size={18} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}

/**
 * The one "Show on" dialog, mounted at the app root: the screens and speakers the user may write
 * to, each given what was open when it was asked for (`openShowOn`), or stopped, and a screen near
 * the browser for what can go to one.
 */
export function ShowOnHost() {
  useSignals();
  const target = showOnTarget.value;
  const [shown, setShown] = useState<ShowOnTarget | null>(null);
  if (target && target !== shown) setShown(target);
  const devices = showOnDevices.value ?? [];
  const [pages, files] = [showOnNearby.value, showOnNearbyFiles.value];
  const [offered, setOffered] = useState(false);

  useEffect(() => {
    if (target) void loadShowOnDevices(true);
  }, [target]);

  useEffect(() => {
    if (!target || !(pages || files)) return setOffered(false);
    let live = true;
    void offersNearby(target).then((answer) => live && setOffered(answer));
    return () => {
      live = false;
    };
  }, [target, pages, files]);

  if (!shown) return null;

  return (
    <Dialog opened={target !== null} onClose={closeShowOn} title={`Show “${shown.title}” on`} icon='cast' size='sm' floating>
      <Stack gap='xs'>
        {devices.length === 0 && !offered && <Text c='dimmed'>No screen or speaker you may show on.</Text>}
        {devices.map((device) => <DeviceRow key={device.name} device={device} target={shown} onShown={closeShowOn} />)}
        {offered && <NearbyRow target={shown} onShown={closeShowOn} />}
      </Stack>
    </Dialog>
  );
}
