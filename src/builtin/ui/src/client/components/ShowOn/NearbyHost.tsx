import { ActionIcon, Button, Group, Loader, Stack, Text, Tooltip } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { useState } from 'react';
import {
  chooseScreen,
  closeNearby,
  nearbyDialog,
  nearbyPlayback,
  nearbyScreen,
  nearbyStream,
  pauseNearby,
  playNearby,
  seekNearby,
  type ShowOnTarget,
  startNearby,
  stopScreen,
} from '../../signals/show-on.ts';
import { TablerIcon } from '../Icon/TablerIcon.tsx';
import { Dialog } from '../Surface/Dialog.tsx';

/** A time in seconds as m:ss, or h:mm:ss from an hour. */
const clock = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds));
  const [h, m, s] = [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60];
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

function Control({ label, icon, onClick, size = 'xl' }: { label: string; icon: string; onClick: () => void; size?: string }) {
  return (
    <Tooltip label={label}>
      <ActionIcon variant='default' size={size} radius='xl' aria-label={label} onClick={onClick}>
        <TablerIcon name={icon} size={size === 'xl' ? 22 : 18} />
      </ActionIcon>
    </Tooltip>
  );
}

/** What a screen near the browser plays: play and pause, and for a recording or video back and forward with where it is; and Stop. */
function Playing({ shown }: { shown: ShowOnTarget }) {
  useSignals();
  const screen = nearbyScreen.value;
  const playback = nearbyPlayback.value;
  if (!screen) return null;
  const timed = !screen.page && Number.isFinite(playback.duration);
  return (
    <Stack gap='md'>
      <Text>
        {playback.paused ? 'Paused' : 'Playing'} “{screen.target.title}” on a screen near you.
      </Text>
      <Group justify='center' gap='md'>
        {!screen.page && <Control label='Back 10 seconds' icon='rewind-backward-10' size='lg' onClick={() => seekNearby(-10)} />}
        {playback.paused ? <Control label='Play' icon='player-play' onClick={playNearby} /> : <Control label='Pause' icon='player-pause' onClick={pauseNearby} />}
        {!screen.page && <Control label='Forward 30 seconds' icon='rewind-forward-30' size='lg' onClick={() => seekNearby(30)} />}
      </Group>
      {timed && <Text size='sm' c='dimmed' ta='center'>{clock(playback.time)} / {clock(playback.duration)}</Text>}
      <Group justify='space-between'>
        <Button
          variant='light'
          color='red'
          leftSection={<TablerIcon name='player-stop' size={16} />}
          onClick={() => {
            stopScreen();
            closeNearby();
          }}
        >
          Stop
        </Button>
        {screen.target.path !== shown.path && (
          <Button variant='default' leftSection={<TablerIcon name='cast' size={16} />} onClick={() => void startNearby(shown)}>
            Show “{shown.title}” instead
          </Button>
        )}
      </Group>
      <Text size='xs' c='dimmed'>It plays on when you close this; the cast icon opens it again.</Text>
    </Stack>
  );
}

/**
 * The dialog of the screen near the browser, mounted at the app root and opened by the cast icon
 * (`openNearby`): the stream being made, then "Choose the screen", which opens the browser's
 * picker from a tap of its own, and what a screen plays, to pause, move in or stop.
 */
export function NearbyHost() {
  useSignals();
  const target = nearbyDialog.value;
  const [shown, setShown] = useState<ShowOnTarget | null>(null);
  if (target && target !== shown) setShown(target);
  if (!shown) return null;
  const stream = nearbyStream.value?.target.path === shown.path ? nearbyStream.value : null;
  const screen = nearbyScreen.value;

  return (
    <Dialog opened={target !== null} onClose={closeNearby} title='Show on a screen near you' icon='cast' size='sm' floating>
      {stream?.step === 'starting' && (
        <Group gap='sm' wrap='nowrap'>
          <Loader size='sm' />
          <Text>Making “{shown.title}” into a video for the screen. This takes a few seconds.</Text>
        </Group>
      )}
      {stream?.step === 'connecting' && (
        <Group gap='sm' wrap='nowrap'>
          <Loader size='sm' />
          <Text>Handing “{shown.title}” to the screen…</Text>
        </Group>
      )}
      {(stream?.step === 'ready' || stream?.step === 'looking') && (
        <Stack gap='md'>
          <Text>“{shown.title}” is ready. Choose the screen to show it on.</Text>
          {stream.step === 'ready' && stream.problem && <Text size='sm' c='red'>{stream.problem}</Text>}
          <Button leftSection={<TablerIcon name='cast' size={18} />} loading={stream.step === 'looking'} onClick={() => void chooseScreen()}>
            Choose the screen
          </Button>
          {stream.step === 'looking' && <Text size='sm' c='dimmed' ta='center'>Looking for screens near you…</Text>}
        </Stack>
      )}
      {stream?.step === 'failed' && (
        <Stack gap='md'>
          <Text c='red'>{stream.problem}</Text>
          <Button variant='default' leftSection={<TablerIcon name='refresh' size={16} />} onClick={() => void startNearby(shown)}>Try again</Button>
        </Stack>
      )}
      {!stream && screen && <Playing shown={shown} />}
      {!stream && !screen && <Button leftSection={<TablerIcon name='cast' size={18} />} onClick={() => void startNearby(shown)}>Show “{shown.title}”</Button>}
    </Dialog>
  );
}
