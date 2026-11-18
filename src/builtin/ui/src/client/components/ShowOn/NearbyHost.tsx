import { ActionIcon, Button, Divider, Group, Image, Loader, Paper, Slider, Stack, Text, Tooltip } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import type { ScreenState } from '@ein/api';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  castInstead,
  chooseScreen,
  closeNearby,
  nearbyCast,
  nearbyDialog,
  nearbyPageState,
  nearbyPlayback,
  nearbyScreen,
  nearbyStream,
  pauseNearby,
  playNearby,
  pressNearby,
  seekNearby,
  type ShowOnTarget,
  startNearby,
  stopScreen,
  tellNearbyPage,
} from '../../signals/show-on.ts';
import { thumbnailUrl } from '../../lib/derivatives.ts';
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

/** How often the dialog asks a page on the screen what it shows. */
const PAGE_STATE_MS = 1000;

/** What the page on the screen says it shows, asked every second while `stream` is set; `null` until it says. */
function usePageState(stream: string | undefined): ScreenState | null {
  const [state, setState] = useState<ScreenState | null>(null);
  useEffect(() => {
    setState(null);
    if (!stream) return;
    let live = true;
    const read = () => void nearbyPageState().then((found) => live && setState(found)).catch(() => {});
    read();
    const timer = setInterval(read, PAGE_STATE_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [stream]);
  return state;
}

/**
 * Where a page's video or recording is, to move it: a slider of its length and back and forward 10
 * seconds, which tell the page to seek. The slider holds where it is dragged to until the page has moved.
 */
function PageMedia({ media, tell }: { media: NonNullable<ScreenState['media']>; tell: (seconds: number) => void }) {
  const [dragged, setDragged] = useState<number | null>(null);
  const dragging = useRef(false);
  const duration = Math.max(media.duration, 0);
  const at = dragged ?? Math.min(media.time, duration);
  const seek = (seconds: number) => tell(Math.min(Math.max(seconds, 0), duration));
  // The page's next word on where it is ends what was dragged, unless a drag goes on.
  useEffect(() => {
    if (!dragging.current) setDragged(null);
  }, [media.time]);
  return (
    <Stack gap={4}>
      <Slider
        min={0}
        max={duration || 1}
        step={1}
        value={at}
        label={clock}
        onChange={(seconds) => {
          dragging.current = true;
          setDragged(seconds);
        }}
        onChangeEnd={(seconds) => {
          dragging.current = false;
          seek(seconds);
        }}
        aria-label='Where in the video'
      />
      <Group justify='space-between'>
        <Text size='sm' c='dimmed'>{clock(at)}</Text>
        <Text size='sm' c='dimmed'>{clock(duration)}</Text>
      </Group>
      <Group justify='center' gap='md'>
        <Control label='Back 10 seconds' icon='rewind-backward-10' size='lg' onClick={() => seek(media.time - 10)} />
        <Control label='Forward 10 seconds' icon='rewind-forward-10' size='lg' onClick={() => seek(media.time + 10)} />
      </Group>
    </Stack>
  );
}

/** What a page on the screen says it shows, in a card: the file's picture, its name, and where it is in a slideshow. */
function PageShown({ state }: { state: ScreenState }) {
  const [pictured, setPictured] = useState(true);
  useEffect(() => setPictured(true), [state.path]);
  return (
    <Paper withBorder radius='md' p='sm'>
      <Stack gap={6} align='center'>
        {state.path && pictured && <Image src={thumbnailUrl(state.path, true)} w={96} h={96} radius='sm' fit='cover' alt='' onError={() => setPictured(false)} />}
        {state.title && <Text ta='center' truncate='end' maw='100%'>{state.title}</Text>}
        {state.position && <Text size='sm' c='dimmed' ta='center'>{state.position}</Text>}
      </Stack>
    </Paper>
  );
}

/**
 * What a screen near the browser plays: a recording or video's play and pause, back and forward
 * with where it is; for a page, what it says it shows, its keys, which act in the page itself (a
 * slideshow's previous, pause and next), as its live video only shows, and for its video or
 * recording a slider and back and forward 10 seconds; and, below a divider, Stop casting. It is
 * headed by what was sent, as `Album: Summer`, which opens it.
 */
function Playing({ shown }: { shown: ShowOnTarget }) {
  useSignals();
  const [problem, setProblem] = useState<string | null>(null);
  const screen = nearbyScreen.value;
  const playback = nearbyPlayback.value;
  const state = usePageState(screen?.page ? screen.stream : undefined);
  if (!screen) return null;
  const timed = !screen.page && Number.isFinite(playback.duration);
  // The page the dialog is opened from knows its keys as they are now; what the screen was given
  // when it started, kept with it, may be from an older EiN.
  const sent = shown.path === screen.target.path ? shown : screen.target;
  const keys = screen.page && screen.stream ? sent.keys ?? [] : [];
  const failed = (error: unknown) => setProblem(error instanceof Error ? error.message : String(error));
  const press = (key: string) => {
    setProblem(null);
    pressNearby(key).catch(failed);
  };
  const seek = (seconds: number) => {
    setProblem(null);
    tellNearbyPage({ seek: seconds }).catch(failed);
  };
  return (
    <Stack gap='md'>
      <Text>
        {sent.kind && `${sent.kind}: `}
        <Text component={Link} to={screen.link} c='var(--mrx-accent)' inherit onClick={closeNearby}>{screen.target.title}</Text>
      </Text>
      {screen.page && state && (state.title || state.path) && <PageShown state={state} />}
      {screen.page && state?.media && <PageMedia media={state.media} tell={seek} />}
      {screen.page
        ? keys.length > 0 && (
          <Group justify='center' gap='md'>
            {keys.map((each) => <Control key={each.key} label={each.label} icon={each.icon} onClick={() => press(each.key)} />)}
          </Group>
        )
        : (
          <Group justify='center' gap='md'>
            <Control label='Back 10 seconds' icon='rewind-backward-10' size='lg' onClick={() => seekNearby(-10)} />
            {playback.paused ? <Control label='Play' icon='player-play' onClick={playNearby} /> : <Control label='Pause' icon='player-pause' onClick={pauseNearby} />}
            <Control label='Forward 30 seconds' icon='rewind-forward-30' size='lg' onClick={() => seekNearby(30)} />
          </Group>
        )}
      {problem && <Text size='sm' c='red' ta='center'>{problem}</Text>}
      {timed && <Text size='sm' c='dimmed' ta='center'>{clock(playback.time)} / {clock(playback.duration)}</Text>}
      {shown.path && screen.target.path !== shown.path && (
        <Button variant='default' leftSection={<TablerIcon name='cast' size={16} />} onClick={() => void castInstead(shown)}>
          Show “{shown.title}” instead
        </Button>
      )}
      <Divider />
      <Button
        fullWidth
        variant='light'
        color='red'
        leftSection={<TablerIcon name='player-stop' size={16} />}
        onClick={() => {
          stopScreen();
          closeNearby();
        }}
      >
        Stop casting
      </Button>
      <Text size='xs' c='dimmed' ta='center'>It plays on when you close this; the cast icon opens it again.</Text>
    </Stack>
  );
}

/**
 * The dialog of the screen near the browser, mounted at the app root and opened by the cast icon
 * (`openNearby`): the stream being made, then "Choose the screen", which opens the browser's
 * picker from a tap of its own, and what a screen plays, to pause, move in, step through or stop.
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
    <Dialog opened={target !== null} onClose={closeNearby} title='Casting' icon='cast' size='sm' floating>
      {stream?.step === 'starting' && (
        <Group gap='sm' wrap='nowrap'>
          <Loader size='sm' />
          <Text>Getting “{shown.title}” ready for the screen. This takes a few seconds.</Text>
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
      {!stream && !screen && (
        <Stack gap='md'>
          {nearbyCast.value && <Text>A screen near you is connected, and plays nothing from here.</Text>}
          {shown.path && <Button leftSection={<TablerIcon name='cast' size={18} />} onClick={() => void startNearby(shown)}>Show “{shown.title}”</Button>}
          {nearbyCast.value && (
            <Button
              variant='light'
              color='red'
              leftSection={<TablerIcon name='player-stop' size={16} />}
              onClick={() => {
                stopScreen();
                closeNearby();
              }}
            >
              Disconnect
            </Button>
          )}
        </Stack>
      )}
    </Dialog>
  );
}
