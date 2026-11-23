import { effect, signal } from '@preact/signals-react';
import type { ConfigEntry, ControlAnswer, DeviceSummary, ScreenKey, ScreenMessage, ScreenState, StreamedFile, StreamedPage } from '@ein/api';
import { fileUrl } from '../lib/file-url.ts';
import { shq } from '../lib/shquote.ts';
import {
  castCaptions,
  castConnected,
  type CastCustom,
  castedBefore,
  type CastItem,
  castLoad,
  castLoaded,
  castPause,
  castPlay,
  castSeek,
  type CastState,
  castStop,
  lastGiven,
  loadCast,
  onCast,
  requestCast,
} from './cast-sender.ts';
import { execCommand, execFrameCommand } from './shell-client.ts';
import { currentUser } from './user.ts';

/**
 * What a screen or speaker is to show or play: the path of a file, or of a page as the address bar
 * has it (`/slideshow?q=sailboat&slideshow=screen`), and what to call it. A file that is not a recording
 * or a video, such as a picture, may name the page that shows it (`page`), which a screen near the
 * browser is given instead where the browser hands such a screen only a video (Remote Playback;
 * Cast shows a picture itself). A page that takes keys says which (`keys`): a screen near the
 * browser showing it has a button for each, which presses the key in the page the screen shows.
 * `kind` says what it is, before its title where it is named ("Album", "Video").
 */
export type ShowOnTarget = { path: string; title: string; page?: string; keys?: ScreenKey[]; kind?: string };

/**
 * What the "Show on" dialog, of the screens and speakers EiN reaches, is open for, or `null`. Held
 * here, as the sharing dialog is, so a menu item can open it: the menu's dropdown is unmounted by
 * the same click.
 */
export const showOnTarget = signal<ShowOnTarget | null>(null);

export function openShowOn(target: ShowOnTarget) {
  showOnTarget.value = target;
}

export function closeShowOn() {
  showOnTarget.value = null;
}

/** The screens and speakers whose `show` the user may write, by label; `null` until they are read. */
export const showOnDevices = signal<DeviceSummary[] | null>(null);

/**
 * Whether a page can be shown on a screen near the browser, one EiN does not reach itself: the
 * browser hands a video to a screen (the Remote Playback API: Cast in Chrome, AirPlay in Safari;
 * Firefox has none), and a command renders pages as video (`CFG_PAGE_STREAMER`, `stream-page`).
 */
export const showOnNearby = signal(false);

/**
 * Whether a recording or video can be shown on a screen near the browser: the browser hands it the
 * file's address, which a command makes (`CFG_FILE_STREAMER`, `stream-file`).
 */
export const showOnNearbyFiles = signal(false);

let read: { user: string | undefined; done: Promise<void> } | undefined;

/** Read the screens and speakers, and whether there is a screen near the browser: once for whoever is signed in, again when `fresh`. */
export function loadShowOnDevices(fresh = false): Promise<void> {
  const user = currentUser.value?.username;
  if (read && read.user === user && !fresh) return read.done;
  const devices = execFrameCommand<DeviceSummary[]>('devices --endpoint show').then(
    (devices) => {
      showOnDevices.value = devices;
    },
    () => {
      showOnDevices.value = [];
    },
  );
  const setting = (key: string, into: typeof showOnNearby) =>
    'remote' in HTMLMediaElement.prototype
      ? execFrameCommand<ConfigEntry>(`config get ${key}`).then(
        (entry) => {
          into.value = Boolean(entry.value?.trim());
        },
        () => {
          into.value = false;
        },
      )
      : Promise.resolve();
  const done = Promise.all([devices, setting('CFG_PAGE_STREAMER', showOnNearby), setting('CFG_FILE_STREAMER', showOnNearbyFiles)]).then(() => {});
  read = { user, done };
  return done;
}

/**
 * Whether `target` is a page, which `stream-page` renders, rather than a file: a path in one of
 * EiN's folders is a file, as a screen's driver tells them apart.
 */
export const isPage = async (target: ShowOnTarget): Promise<boolean> => {
  const folder = `/${target.path.split('/')[1]?.split('?')[0] ?? ''}`;
  if (folder === '/') return false;
  return await execCommand(`stat ${shq(folder)}`).then(() => false, () => true);
};

/** What `target` goes to a screen near the browser as: a page, by its route, or a file. */
type NearbyForm = { page: string } | { file: string };

/** `target` as it goes to a screen near the browser: a picture as itself where the screen takes `pictures` (Cast), else as its page. */
const nearbyForm = async (target: ShowOnTarget, pictures = false): Promise<NearbyForm | undefined> => {
  if (await isPage(target)) return showOnNearby.value ? { page: target.path } : undefined;
  const node = await execCommand<{ attrs?: { mimetype?: unknown } }>(`stat ${shq(target.path)}`).catch(() => undefined);
  const mimetype = typeof node?.attrs?.mimetype === 'string' ? node.attrs.mimetype : '';
  if (/^(audio|video)\//.test(mimetype)) return showOnNearbyFiles.value ? { file: target.path } : undefined;
  if (pictures && mimetype.startsWith('image/') && showOnNearbyFiles.value) return { file: target.path };
  return target.page && showOnNearby.value ? { page: target.page } : undefined;
};

/** Whether this browser may cast with Google's script (Chrome, over HTTPS), and so show a picture as itself. */
const mayCast = (): boolean => globalThis.isSecureContext && 'chrome' in globalThis;

/** Whether `target` can go to a screen near the browser: a page, a recording or video, a picture where Cast shows it, or a file that names its page. */
export const offersNearby = async (target: ShowOnTarget): Promise<boolean> => (await nearbyForm(target, mayCast())) !== undefined;

/** Write to one of a device's controls: its JSON answer, or throws its refusal. */
const writeDevice = async <T>(path: string, body: string): Promise<T> => {
  const response = await fetch(fileUrl(path), { method: 'POST', body });
  const text = await response.text();
  if (!response.ok) throw new Error(text || response.statusText);
  try {
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
};

/** Give `target` to a screen or speaker, written to its `show`: its driver's word on it, such as "playing Morning song". */
export const showOn = (device: DeviceSummary, target: ShowOnTarget): Promise<ControlAnswer> => writeDevice<ControlAnswer>(`${device.path}/show`, `${target.path}\n`);

/** Stop what a screen or speaker shows or plays. */
export const stopShowing = async (device: DeviceSummary): Promise<void> => {
  await writeDevice<unknown>(`${device.path}/stop`, 'press');
};

/**
 * The video a screen near the browser plays: one for the whole app, kept in the document while the
 * screen plays it, since the browser ends the cast with the element. It is never played here, but
 * its start is read (`preload` metadata): the browser offers a source to screens only once its
 * player has loaded it, and Chrome only one longer than 15 s. So a page is given as live HLS, whose
 * duration is endless; an endless MP4's is only what has been read of it. A recording or video is
 * given as a file, or as HLS of its whole length.
 */
let nearbyVideo: HTMLVideoElement | undefined;

/**
 * What a screen near the browser plays, whether it is a page, which goes as live video, so has no
 * time to move in, where in EiN it was sent from (`link`), to go back to it, and a page's stream,
 * which its keys are pressed in by (`StreamedPage.id`).
 */
export type NearbyShown = { target: ShowOnTarget; page: boolean; link: string; stream?: string };

/** What the screen near the browser plays, once a screen has taken it; `null` while it plays nothing of ours. */
export const nearbyScreen = signal<NearbyShown | null>(null);

/**
 * Whether the browser holds a screen near it by Cast: it is given another file or page without
 * the picker (`castInstead`), also while it plays nothing.
 */
export const nearbyCast = signal(false);

/**
 * Whether what the screen near the browser plays is paused, where it is and how long it lasts, in
 * seconds, as the browser hears from the screen; `waiting` while it plays but waits for what comes
 * next (Cast only), so its time stands.
 */
export type NearbyPlayback = { paused: boolean; time: number; duration: number; waiting?: boolean };

export const nearbyPlayback = signal<NearbyPlayback>({ paused: true, time: 0, duration: NaN });

/** When `nearbyPlayback` was last heard, so its time can be told on from there while it plays. */
let heardAt = 0;

const hearPlayback = (playback: NearbyPlayback): void => {
  heardAt = performance.now();
  const last = nearbyPlayback.peek();
  if (last.paused === playback.paused && last.waiting === playback.waiting && last.time === playback.time && Object.is(last.duration, playback.duration)) return;
  nearbyPlayback.value = playback;
};

/** Where what the screen plays is now, in seconds: the time last heard, and what has played since. */
const nearbyTime = (): number => {
  const { paused, waiting, time } = nearbyPlayback.peek();
  return paused || waiting ? time : time + (performance.now() - heardAt) / 1000;
};

/** Whether the screen near the browser shows a recording's or video's captions, as its player here does. */
export const nearbyCaptions = signal(true);

/** Show or hide the captions of what the screen near the browser plays, from the player's own setting. */
export const setNearbyCaptions = (on: boolean): void => {
  if (nearbyCaptions.peek() === on) return;
  nearbyCaptions.value = on;
  if (castConnected()) castCaptions(on);
};

/** What the hidden video was last given, which the screen plays once one takes it. */
let streamed: NearbyShown | undefined;

/** The source the screen took, so a `disconnect` for a source given since is told apart. */
let connectedSource = '';

/** While `castInstead` gives the screen another source, which a browser may answer by letting the screen go. */
let swapping = false;

/** Whether the browser says a screen near it takes the stream; `undefined` while it has not said, or cannot. */
let nearbyAvailable: boolean | undefined;

/** Called once the browser says a screen takes the stream. */
const onAvailable = new Set<() => void>();

const nearby = (): HTMLVideoElement => {
  if (nearbyVideo) return nearbyVideo;
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.playsInline = true;
  video.setAttribute('aria-hidden', 'true');
  Object.assign(video.style, { position: 'fixed', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
  document.body.append(video);
  // Once a screen takes it, play there; the browser carries play, pause and a new time over.
  video.remote.addEventListener('connecting', () => {
    const stream = nearbyStream.value;
    if (stream) nearbyStream.value = { target: stream.target, step: 'connecting' };
  });
  video.remote.addEventListener('connect', () => {
    connectedSource = video.src;
    clearTimeout(forgetTimer);
    nearbyStream.value = null;
    nearbyScreen.value = streamed ?? null;
    void video.play().catch(() => {});
  });
  // The screen let go, as the browser's picker or the TV's remote stops it: what was made for it
  // goes too, unless the video has been given another stream since, whose start let the screen go.
  video.remote.addEventListener('disconnect', () => {
    nearbyScreen.value = null;
    if (swapping) return;
    if (video.src === connectedSource) stopNearby();
    else if (nearbyStream.value?.step === 'connecting') nearbyStream.value = { target: nearbyStream.value.target, step: 'ready' };
  });
  const heard = () => hearPlayback({ paused: video.paused, time: video.currentTime, duration: video.duration });
  for (const event of ['play', 'pause', 'timeupdate', 'durationchange', 'seeked']) video.addEventListener(event, heard);
  // Chrome on Android pauses a hidden page's video, the screen's with it, when the person leaves
  // the page; it plays on when they come back. What they paused themselves before leaving stays.
  let playingWhenHidden = false;
  document.addEventListener('visibilitychange', () => {
    const connected = video.remote.state === 'connected';
    if (document.hidden) playingWhenHidden = connected && !video.paused;
    else if (playingWhenHidden && connected && video.paused) void video.play().catch(() => {});
  });
  watchScreens(video);
  nearbyVideo = video;
  return video;
};

/** Hear whether a screen near the browser takes `video`'s source; a browser that cannot watch (some phones save the battery) leaves it unknown. */
const watchScreens = (video: HTMLVideoElement): void => {
  void video.remote.watchAvailability((available) => {
    nearbyAvailable = available;
    if (available) { for (const each of onAvailable) each(); }
  }).catch(() => {});
};

/**
 * End the browser's session with the screen, if it has one: pausing the video or taking its source
 * leaves the screen held, on its cast icon once the stream is gone. Turning remote playback off by
 * the property closes the session, and forgets the watch, which starts again.
 */
const endSession = (video: HTMLVideoElement): void => {
  if (video.remote.state === 'disconnected') return;
  video.disableRemotePlayback = true;
  video.disableRemotePlayback = false;
  watchScreens(video);
};

/**
 * Have Chrome decide again whether a screen may have `video`'s source. It decides when the
 * source's metadata comes, before the element knows its duration, so that it offers nothing, and
 * then only when the duration changes, which a stream's declared one never does. Turning remote
 * playback off and on, by the attribute, which keeps the watch, has it decide now with the
 * duration known. Not while a screen plays it, which turning it off would end.
 */
const offerAgain = (video: HTMLVideoElement): void => {
  if (video.remote.state !== 'disconnected') return;
  video.setAttribute('disableremoteplayback', '');
  video.removeAttribute('disableremoteplayback');
};

/** How long a tap waits for the browser to find a screen before it opens the picker anyway, inside the five seconds Chrome counts a tap. */
const FIND_SCREEN_MS = 4_500;

/**
 * Wait until the browser says a screen takes the stream, the tap that asked no longer counts (Chrome
 * counts one five seconds, and the picker needs one), or `FIND_SCREEN_MS`; the picker opened before
 * the browser has found a screen finds none.
 */
const screenFound = (): Promise<void> =>
  new Promise((resolve) => {
    if (nearbyAvailable) return resolve();
    const done = () => {
      clearTimeout(timer);
      clearInterval(tap);
      onAvailable.delete(done);
      resolve();
    };
    const timer = setTimeout(done, FIND_SCREEN_MS);
    const tap = setInterval(() => {
      if (navigator.userActivation && !navigator.userActivation.isActive) done();
    }, 100);
    onAvailable.add(done);
  });

/**
 * The form of a page's stream the browser's own Remote Playback hands a screen: Safari (AirPlay)
 * takes the live HLS; Chrome hands a Cast screen no HLS on Android, nor an endless MP4, which it
 * counts as long as it has read, so it gets the MP4 whose header says it lasts a day. With Google's
 * Cast script the receiver is given the endless MP4 as live instead (`castShow`).
 */
const pageSource = (page: StreamedPage): string => 'WebKitPlaybackTargetAvailabilityEvent' in globalThis ? page.hls : page.remote;

/** How often what EiN keeps for the screen near the browser is renewed: it is let go of five minutes after the last time. */
const RENEW_MS = 60_000;

/** The recording or video EiN keeps for the screen near the browser, by `stream-file`'s id, while this renews it. */
let heldFile: { id: string; timer: ReturnType<typeof setInterval> } | undefined;

const holdFile = (id: string): void => {
  if (heldFile?.id === id) return;
  releaseFile();
  const timer = setInterval(() => {
    void execCommand(`stream-file --renew ${shq(id)}`).catch(() => {
      if (heldFile?.id !== id) return;
      clearInterval(timer);
      heldFile = undefined;
    });
  }, RENEW_MS);
  heldFile = { id, timer };
};

/** Let go of the recording or video EiN keeps for the screen near the browser. */
const releaseFile = (): void => {
  if (!heldFile) return;
  clearInterval(heldFile.timer);
  void execCommand(`stream-file --stop ${shq(heldFile.id)}`).catch(() => {});
  heldFile = undefined;
};

/** Counts the streams asked for, so one overtaken while it is made does not take the video from the next. */
let streams = 0;

/** How long the stream may take to start before it is given up. */
const NEARBY_START_MS = 20_000;

/** Wait until `video`'s player has read the start of its source; throws when it cannot. */
const loaded = (video: HTMLVideoElement): Promise<void> =>
  new Promise((resolve, reject) => {
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return resolve();
    const done = (error?: Error) => {
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', ok);
      video.removeEventListener('error', failed);
      if (error) reject(error);
      else resolve();
    };
    const ok = () => done();
    const failed = () => done(new Error(`the stream did not play here${video.error?.message ? `: ${video.error.message}` : ''}`));
    const timer = setTimeout(() => done(new Error('the stream did not start')), NEARBY_START_MS);
    video.addEventListener('loadedmetadata', ok);
    video.addEventListener('error', failed);
  });

/**
 * Give `target` to the video a screen near the browser plays, on the origin EiN was reached at: a
 * page rendered as live video, in the form this browser hands a screen; a recording or video as `stream-file` makes it,
 * kept while this renews it. Then wait until its player has read the start, after which the
 * browser looks for a screen that takes it, and `chooseNearby` lets the person pick one.
 */
export const streamNearby = async (target: ShowOnTarget, keepScreen = false): Promise<void> => {
  const own = ++streams;
  const form = await nearbyForm(target);
  if (!form) throw new Error(`${target.title} cannot go to a screen near you`);
  let source: string;
  let held: string | undefined;
  let stream: string | undefined;
  if ('page' in form) {
    const page = await execCommand<StreamedPage>(`stream-page ${shq(form.page)}`);
    source = pageSource(page);
    stream = page.id;
  } else {
    const file = await execCommand<StreamedFile>(`stream-file ${shq(form.file)}`);
    source = file.url;
    held = file.id;
  }
  if (own !== streams) {
    if (held) void execCommand(`stream-file --stop ${shq(held)}`).catch(() => {});
    throw new DOMException('another stream took its place', 'AbortError');
  }
  const video = nearby();
  // A screen still held, by what it played before or by a stream that has ended, is let go: each
  // showing is chosen anew, unless `keepScreen` asks to give the screen playing the new one.
  if (!keepScreen) endSession(video);
  video.src = new URL(source, location.origin).href;
  video.title = target.title;
  streamed = { target, page: 'page' in form, link: `${location.pathname}${location.search}`, ...(stream ? { stream } : {}) };
  if (held) holdFile(held);
  else releaseFile();
  try {
    await loaded(video);
  } catch (error) {
    stopNearby();
    throw error;
  }
  offerAgain(video);
};

/**
 * The browser's own picker of the screens near it; once one plays the stream it offers to stop.
 * Must be called from a tap (`InvalidAccessError` without one); `NotAllowedError` is the picker
 * dismissed, and `NotFoundError` no screen near the browser that takes the stream. A browser that
 * offers the stream to none cancels the picker at once, as if dismissed: unless it said a screen
 * takes it, that is a `NotFoundError` too, whose message keeps the browser's own words, or a
 * `NotSupportedError` for a recording or video too short for Chrome to offer.
 */
export const chooseNearby = (): Promise<void> => {
  const video = nearby();
  return video.remote.prompt().catch((error) => {
    const name = error instanceof DOMException ? error.name : '';
    const duration = video.duration;
    const short = duration < MIN_OFFERED_S;
    if (name === 'NotAllowedError' && nearbyAvailable !== true) {
      if (short) throw new DOMException(`the browser hands a screen nothing shorter than ${MIN_OFFERED_S} seconds`, 'NotSupportedError');
      // What the browser said, with what it knew: the duration it offers by, and whether it said a screen takes it.
      const screens = nearbyAvailable === undefined ? 'it never said whether a screen takes it' : 'it says no screen takes it';
      throw new DOMException(`“${(error as DOMException).message}”; ${duration} s; ${screens}`, 'NotFoundError');
    }
    throw error;
  });
};

/** Chrome offers a screen no recording or video shorter than this, in seconds. */
const MIN_OFFERED_S = 15;

/**
 * Let go of what was made for the screen near the browser unless a screen has it: the hidden
 * video reads a page's live playlist for as long as it holds it, which keeps the stream running.
 */
const releaseNearby = (): void => {
  if (nearbyVideo && nearbyVideo.remote.state === 'disconnected') stopNearby();
};

/** Stop what the screen near the browser shows: a page's stream ends once nobody reads it, and a file EiN kept for it is let go of. */
export const stopNearby = (): void => {
  releaseFile();
  const video = nearbyVideo;
  if (!video) return;
  endSession(video);
  video.pause();
  video.removeAttribute('src');
  video.removeAttribute('title');
  video.load();
  streamed = undefined;
  nearbyScreen.value = null;
};

/**
 * Where the stream for a screen near the browser stands, before a screen plays it: `starting`
 * while it is made and its start read, `ready` for the picker (with what kept the last pick from
 * a screen), `looking` while a tap waits for the browser to find a screen before it opens the
 * picker, `connecting` while the chosen screen takes it, and `failed`; `null` when there is none.
 */
export type NearbyStream =
  | { target: ShowOnTarget; step: 'starting' | 'looking' | 'connecting' }
  | { target: ShowOnTarget; step: 'ready'; problem?: string }
  | { target: ShowOnTarget; step: 'failed'; problem: string };

export const nearbyStream = signal<NearbyStream | null>(null);

/**
 * What the dialog of the screen near the browser is open for, or `null`: it shows the stream being
 * made, offers the picker once it is ready, and controls what a screen plays. Closed, a screen
 * plays on. An empty path is the screen Cast holds, from the top bar, with nothing of ours known to
 * play on it.
 */
export const nearbyDialog = signal<ShowOnTarget | null>(null);

/** Counts the streams started, so one given up or overtaken while it starts lets the video be. */
let nearbyAsked = 0;

/** How long a stream no screen has taken is kept, once its dialog is closed. */
const KEEP_MS = 60_000;

let forgetTimer: ReturnType<typeof setTimeout> | undefined;

/** Let go of the stream no screen has taken. */
const forgetNearby = (): void => {
  nearbyAsked++;
  streams++;
  clearTimeout(forgetTimer);
  nearbyStream.value = null;
  releaseNearby();
};

/** How long a tap on the cast icon has to bring up the picker before the dialog opens instead: the five seconds Chrome counts a tap. */
const PICKER_MS = 5_000;

/** Whether the browser's picker is open. */
let picking = false;

/** Opens the dialog once the cast icon's tap has had its time for the picker. */
let pickerDue: ReturnType<typeof setTimeout> | undefined;

/** Open the dialog for `target`, ending the cast icon's try at the picker without it. */
const showDialog = (target: ShowOnTarget): void => {
  clearTimeout(pickerDue);
  nearbyDialog.value = target;
};

/**
 * From the cast icon: the dialog for what a screen plays, or `target`'s stream being made or
 * waiting for its screen. Otherwise `target`'s stream is started and the browser's picker opened
 * as soon as it can be, without the dialog, which opens only when the picker has not come within
 * the tap (`PICKER_MS`), or something went wrong.
 */
export function openNearby(target: ShowOnTarget) {
  clearTimeout(forgetTimer);
  const stream = nearbyStream.value;
  if (nearbyScreen.value || nearbyCast.value || (stream?.target.path === target.path && stream.step !== 'failed')) return showDialog(target);
  if (mayCast()) return void castOpen(target);
  openRemote(target);
}

/** The cast icon's tap by the browser's own Remote Playback: the stream first, then its picker. */
function openRemote(target: ShowOnTarget) {
  clearTimeout(pickerDue);
  pickerDue = setTimeout(() => {
    if (!picking && !nearbyScreen.value && nearbyStream.value?.step !== 'looking') nearbyDialog.value = target;
  }, PICKER_MS);
  void startNearby(target, true);
}

/** Close the dialog: a screen plays on, and a stream none has taken is kept a minute for the cast icon to open it again. */
export function closeNearby() {
  nearbyDialog.value = null;
  if (nearbyStream.value) {
    clearTimeout(forgetTimer);
    forgetTimer = setTimeout(forgetNearby, KEEP_MS);
  }
}

/**
 * Make `target`'s stream for a screen near the browser, in place of any before it. Once it is
 * ready, the picker opens if the tap that asked for it still counts (Chrome counts one five
 * seconds); otherwise the dialog's "Choose the screen" opens it. It cannot open sooner
 * (ein/core#1349: Chrome dismisses it until the source's start is read and a screen is said to
 * take it). `byItself`, from the cast icon without the dialog: the dialog opens when the picker
 * could not, saying why. With Cast, the screen held is given it, or else Chrome's picker opens
 * first, from the tap.
 */
export const startNearby = async (target: ShowOnTarget, byItself = false): Promise<void> => {
  if (castConnected()) return await castShow(target, ++nearbyAsked);
  if (castLoaded()) return void await castPick(target, ++nearbyAsked);
  const asked = ++nearbyAsked;
  clearTimeout(forgetTimer);
  nearbyStream.value = { target, step: 'starting' };
  try {
    await streamNearby(target);
  } catch (error) {
    if (asked !== nearbyAsked) return;
    nearbyStream.value = { target, step: 'failed', problem: error instanceof Error ? error.message : String(error) };
    if (byItself) showDialog(target);
    return;
  }
  // Given up while it started: let it go, unless another stream has taken the video since.
  if (asked !== nearbyAsked) {
    if (!nearbyStream.value) releaseNearby();
    return;
  }
  nearbyStream.value = { target, step: 'ready' };
  if (!byItself && !nearbyDialog.value) {
    forgetTimer = setTimeout(forgetNearby, KEEP_MS);
    return;
  }
  const outcome = navigator.userActivation?.isActive ? await chooseScreen(byItself) : 'lapsed';
  if (!byItself || nearbyDialog.value) return;
  if (outcome === 'lapsed' || outcome === 'problem') return showDialog(target);
  clearTimeout(pickerDue);
  if (outcome === 'dismissed') forgetTimer = setTimeout(forgetNearby, KEEP_MS);
};

/** How a try at the picker ended: a screen `chosen`, the picker `dismissed`, the tap `lapsed` before it, or a `problem`, said in `nearbyStream`. */
export type PickerOutcome = 'chosen' | 'dismissed' | 'lapsed' | 'problem';

/**
 * The browser's picker for the stream that is ready, from a tap, once the browser has found a
 * screen for it or the tap is about to lapse; what kept a screen from taking it stays in
 * `nearbyStream`. The picker dismissed says nothing, nor, `byItself`, a tap that lapsed: the one
 * on the cast icon, which the dialog's own button follows.
 */
export const chooseScreen = async (byItself = false): Promise<PickerOutcome> => {
  const stream = nearbyStream.value;
  if (stream?.step !== 'ready') return 'lapsed';
  if (castLoaded()) return await castPick(stream.target, ++nearbyAsked);
  nearbyStream.value = { target: stream.target, step: 'looking' };
  await screenFound();
  if (nearbyStream.value?.target !== stream.target || nearbyStream.value.step !== 'looking') return 'lapsed';
  nearbyStream.value = { target: stream.target, step: 'ready' };
  picking = true;
  try {
    await chooseNearby();
    return 'chosen';
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotAllowedError') return 'dismissed';
    if (name === 'InvalidAccessError') {
      if (!byItself && nearbyStream.value?.target === stream.target) {
        nearbyStream.value = { target: stream.target, step: 'ready', problem: 'The browser found no screen near you in time; choose again to look once more.' };
      }
      return 'lapsed';
    }
    const said = error instanceof Error ? error.message : String(error);
    // The browser's own words tell one that finds no screen from one that offers this stream to none.
    const problem = name === 'NotFoundError' ? `This browser finds no screen near you to show it on (${said}).` : said;
    if (nearbyStream.value?.target === stream.target) nearbyStream.value = { target: stream.target, step: 'ready', problem };
    return 'problem';
  } finally {
    picking = false;
  }
};

/**
 * Give the screen near the browser `target` in place of what it plays, from a tap: the browser
 * keeps the screen where it can, and where it lets it go, the picker opens from the same tap, or
 * the dialog when that has lapsed. With no screen playing, as the cast icon (`openNearby`).
 */
export const castInstead = async (target: ShowOnTarget): Promise<void> => {
  if (castConnected()) return await castShow(target, ++nearbyAsked);
  const video = nearbyVideo;
  if (!nearbyScreen.peek() || !video) return openNearby(target);
  const asked = ++nearbyAsked;
  clearTimeout(forgetTimer);
  nearbyStream.value = { target, step: 'starting' };
  swapping = true;
  try {
    await streamNearby(target, true);
  } catch (error) {
    swapping = false;
    if (asked !== nearbyAsked) return;
    nearbyStream.value = { target, step: 'failed', problem: error instanceof Error ? error.message : String(error) };
    return showDialog(target);
  }
  swapping = false;
  if (asked !== nearbyAsked) return;
  if (video.remote.state === 'connected') {
    connectedSource = video.src;
    nearbyStream.value = null;
    nearbyScreen.value = streamed ?? null;
    void video.play().catch(() => {});
    return;
  }
  nearbyScreen.value = null;
  nearbyStream.value = { target, step: 'ready' };
  const outcome = navigator.userActivation?.isActive ? await chooseScreen(true) : 'lapsed';
  if (outcome === 'lapsed' || outcome === 'problem') showDialog(target);
};

/** Play what the screen near the browser plays, after a pause. */
export const playNearby = (): void => castConnected() ? castPlay() : void nearbyVideo?.play().catch(() => {});

/** Pause what the screen near the browser plays. */
export const pauseNearby = (): void => castConnected() ? castPause() : nearbyVideo?.pause();

/** Move what the screen near the browser plays to `seconds`, within its length. */
export const seekNearbyTo = (seconds: number): void => {
  const { duration } = nearbyPlayback.peek();
  const at = Math.min(Math.max(seconds, 0), Number.isFinite(duration) ? duration : Infinity);
  if (castConnected()) castSeek(at);
  else if (nearbyVideo) nearbyVideo.currentTime = at;
};

/**
 * Press `key` in the page the screen near the browser shows, as someone at it would
 * (`stream-page --press`): one of the keys its target says the page takes.
 */
export const pressNearby = async (key: string): Promise<void> => {
  const stream = nearbyScreen.peek()?.stream;
  if (!stream) throw new Error('the screen shows no page of ours to press keys in');
  await execCommand(`stream-page --press ${shq(stream)} ${shq(key)}`);
};

/**
 * What the page the screen near the browser shows says it shows (`stream-page --state`): the file and
 * where it is in a slideshow, and a video's time. `null` when it says nothing, or the screen shows no
 * page of ours.
 */
export const nearbyPageState = async (): Promise<ScreenState | null> => {
  const stream = nearbyScreen.peek()?.stream;
  if (!stream) return null;
  return await execCommand<ScreenState | null>(`stream-page --state ${shq(stream)}`);
};

/** Tell the page the screen near the browser shows `message` (`stream-page --message`): move its video to a time. */
export const tellNearbyPage = async (message: ScreenMessage): Promise<void> => {
  const stream = nearbyScreen.peek()?.stream;
  if (!stream) throw new Error('the screen shows no page of ours to tell');
  await execCommand(`stream-page --message ${shq(stream)} ${shq(JSON.stringify(message))}`);
};

/** Move what the screen near the browser plays by `seconds`, back when negative, within its length. */
export const seekNearby = (seconds: number): void => seekNearbyTo(nearbyTime() + seconds);

/** Stop the screen near the browser and let go of its stream, and of one none has taken. */
export const stopScreen = (): void => {
  forgetNearby();
  if (castConnected()) {
    castStop();
    releaseFile();
    nearbyScreen.value = null;
  }
  stopNearby();
};

// --- Cast, in Chrome (`cast-sender.ts`)

/**
 * Join the Cast session that plays, in a browser that has cast before: at the app's start, so the
 * top bar and the players know what a screen near the browser plays after the page is opened again.
 */
export const joinNearby = (): void => {
  if (mayCast() && castedBefore()) void castReady();
};

/** Load Google's script, and once it works, hear the session: true when Cast is there. */
const castReady = async (): Promise<boolean> => {
  if (!(await loadCast())) return false;
  hearCast ??= onCast(heardCast);
  return true;
};

let hearCast: (() => void) | undefined;

/** While `castShow` gives the screen something, which it may report having nothing for a moment. */
let castLoading = 0;

/** When what the screen was last given here was given (`CastCustom.at`): what it reports from before is what it still played. */
let castGivenAt = 0;

/** What the screen shows, as what this browser gave it says. */
const shownOf = (custom: CastCustom): NearbyShown => ({
  target: { path: custom.path, title: custom.title, ...(custom.keys ? { keys: custom.keys } : {}), ...(custom.kind ? { kind: custom.kind } : {}) },
  page: custom.page,
  link: custom.link,
  ...(custom.stream ? { stream: custom.stream } : {}),
});

/**
 * The page stream this browser last gave the screen, once asked whether it still runs: a receiver
 * joined again after the page is opened again may say nothing EiN knows of a page's live video, so
 * the stream, still read, is what says the screen shows it.
 */
let keptPage: string | undefined;

/** Ask once whether the page stream last given still runs, and while Cast holds a screen that says nothing of its own, take it as what it shows. */
const recallPage = (): boolean => {
  const kept = lastGiven();
  if (!kept?.page || !kept.stream) return false;
  if (keptPage === kept.stream) return nearbyScreen.peek()?.stream === kept.stream;
  keptPage = kept.stream;
  void execCommand(`stream-page --state ${shq(kept.stream)}`).then(() => {
    if (nearbyCast.peek() && !nearbyScreen.peek() && keptPage === kept.stream) nearbyScreen.value = shownOf(kept);
  }, () => {});
  return true;
};

/** What the Cast session reports, into the signals the cast icon, its dialog and the players read. */
const heardCast = (state: CastState): void => {
  nearbyCast.value = state.connected;
  if (!state.connected) {
    castGivenAt = 0;
    keptPage = undefined;
    if (heldFile || nearbyScreen.peek()) {
      releaseFile();
      nearbyScreen.value = null;
    }
    return;
  }
  hearPlayback({ paused: state.paused, time: state.time, duration: state.duration, waiting: state.playerState === 'BUFFERING' });
  const custom = state.custom;
  if (!custom) {
    if (!castLoading && !recallPage()) nearbyScreen.value = null;
    return;
  }
  if (custom.at < castGivenAt) return;
  // Given from another page of this browser, or before this one was opened again: kept from here on.
  castGivenAt = custom.at;
  const shown = nearbyScreen.peek();
  if (shown?.target.path !== custom.path || shown.link !== custom.link || shown.stream !== custom.stream) nearbyScreen.value = shownOf(custom);
  if (custom.id && heldFile?.id !== custom.id) holdFile(custom.id);
};

/** What the framework's word for a failed session or load says to a person. */
const castProblem = (word: string): string =>
  ({
    receiver_unavailable: 'This browser finds no screen near you to show it on.',
    timeout: 'The screen did not answer in time.',
    session_error: 'The screen could not be reached.',
    load_failed: 'The screen could not play it.',
  } as Record<string, string>)[word] ?? `The screen near you said: ${word}.`;

/**
 * The cast icon's tap with Cast: Chrome's picker at once, from the tap, since nothing need be made
 * first; then `target` goes to the screen chosen. Google's script is loaded first, the first time;
 * where it is not there, the browser's own Remote Playback; where it took so long the tap lapsed,
 * the dialog's Choose the screen.
 */
const castOpen = async (target: ShowOnTarget): Promise<void> => {
  const asked = ++nearbyAsked;
  nearbyStream.value = { target, step: 'looking' };
  const cast = await castReady();
  if (asked !== nearbyAsked) return;
  if (!cast) {
    nearbyStream.value = null;
    return openRemote(target);
  }
  if (castConnected()) {
    nearbyStream.value = null;
    return showDialog(target);
  }
  if (navigator.userActivation && !navigator.userActivation.isActive) {
    nearbyStream.value = { target, step: 'ready' };
    return showDialog(target);
  }
  await castPick(target, asked);
};

/** Chrome's picker for `target`, from a tap, then `target` on the screen chosen. */
const castPick = async (target: ShowOnTarget, asked: number): Promise<PickerOutcome> => {
  nearbyStream.value = { target, step: 'looking' };
  try {
    await requestCast();
  } catch (error) {
    if (asked !== nearbyAsked) return 'lapsed';
    const word = error instanceof Error ? error.message : String(error);
    if (word === 'cancel') {
      nearbyStream.value = null;
      return 'dismissed';
    }
    nearbyStream.value = { target, step: 'ready', problem: castProblem(word) };
    showDialog(target);
    return 'problem';
  }
  await castShow(target, asked);
  return 'chosen';
};

/**
 * Give the screen held by Cast `target` in place of what it plays: a recording or video as
 * `stream-file` makes it, with its transcript as captions, kept while this renews it; a picture as
 * itself; a page as its endless MP4, played as live with no length: it plays within seconds and a
 * few seconds behind the page, where the receiver stalls on a new page's live HLS, a segment or two
 * long, until it has several (ein/core#1445). What the screen played before is let go of once it
 * has the new.
 */
const castShow = async (target: ShowOnTarget, asked: number): Promise<void> => {
  clearTimeout(forgetTimer);
  nearbyStream.value = { target, step: 'starting' };
  castLoading++;
  let held: string | undefined;
  try {
    const form = await nearbyForm(target, true);
    if (!form) throw new Error(`${target.title} cannot go to a screen near you`);
    const link = `${location.pathname}${location.search}`;
    const at = Date.now();
    const address = (path: string) => new URL(path, location.origin).href;
    let item: CastItem;
    let stream: string | undefined;
    if ('page' in form) {
      const page = await execCommand<StreamedPage>(`stream-page ${shq(form.page)}`);
      stream = page.id;
      item = {
        url: address(`${page.path}.mp4`),
        type: 'video/mp4',
        title: target.title,
        live: true,
        captionsOn: false,
        custom: {
          path: target.path,
          title: target.title,
          link,
          page: true,
          stream: page.id,
          ...(target.keys ? { keys: target.keys } : {}),
          ...(target.kind ? { kind: target.kind } : {}),
          at,
        },
      };
    } else {
      const file = await execCommand<StreamedFile>(`stream-file ${shq(form.file)}`);
      held = file.id;
      item = {
        url: address(file.url),
        type: file.type,
        title: target.title,
        ...(file.captions ? { captions: address(file.captions) } : {}),
        captionsOn: nearbyCaptions.peek(),
        custom: { path: target.path, title: target.title, link, page: false, id: file.id, ...(target.kind ? { kind: target.kind } : {}), at },
      };
    }
    if (asked !== nearbyAsked) throw new DOMException('another took its place', 'AbortError');
    castGivenAt = at;
    await castLoad(item);
    if (held) holdFile(held);
    else releaseFile();
    held = undefined;
    if (asked !== nearbyAsked) return;
    nearbyStream.value = null;
    nearbyScreen.value = { target, page: 'page' in form, link, ...(stream ? { stream } : {}) };
  } catch (error) {
    if (held) void execCommand(`stream-file --stop ${shq(held)}`).catch(() => {});
    if (asked !== nearbyAsked) return;
    const said = error instanceof Error ? error.message : String(error);
    nearbyStream.value = { target, step: 'failed', problem: /^[a-z_]+$/.test(said) ? castProblem(said) : said };
    showDialog(target);
  } finally {
    castLoading--;
  }
};

// --- A player beside the screen

/** How far a player here may be from the screen, in seconds, before its speed is changed to catch up. */
const DRIFT_S = 0.25;

/** How far a player here may be from the paused screen, in seconds, before it is moved to the same frame. */
const PAUSED_DRIFT_S = 0.1;

/** How far a playing player here may be from the screen, in seconds, before it is moved rather than sped up or slowed down. */
const JUMP_S = 3;

/** How much a player here is sped up or slowed down at most to catch up with the screen, as a share of its speed. */
const MAX_NUDGE = 0.25;

/** How long after a player here told the screen something its reports are let settle before the player follows them again. */
const SETTLE_MS = 2_000;

/**
 * Keep `element`, a player here of the file at `path`, in step with the screen near the browser
 * while the screen plays that file: muted, playing as the screen plays and standing while it is
 * paused or waits for more; a little faster or slower while it is a little off, moved to where the
 * screen is when it is far off or the screen is paused. Its own play, pause and moves are told to
 * the screen, so its controls are the screen's. Nothing while the screen plays anything else. The
 * answer stops it, and gives back the sound and the speed.
 */
export const followNearby = (element: HTMLMediaElement, path: string): () => void => {
  const muted = element.muted;
  element.muted = true;
  /** What the element was last told by this, so the events it answers with are not told back to the screen. */
  let told: { paused?: boolean; time?: number } = {};
  let settleUntil = 0;
  let settled: ReturnType<typeof setTimeout> | undefined;
  const here = () => nearbyScreen.peek()?.target.path === path;
  const follow = () => {
    // Ended here, it stays: play on an ended element starts it over, and the screen ends in a moment too.
    if (!here() || document.hidden || element.ended) return;
    const { paused, waiting } = nearbyPlayback.peek();
    // Just told something, the screen may still report what it did before; but that it waits for
    // more, after a move, is news, and the player waits with it.
    if (performance.now() < settleUntil) {
      if (waiting && !element.paused) {
        told = { ...told, paused: true };
        element.pause();
      }
      return;
    }
    const still = paused || waiting === true;
    if (still !== element.paused) {
      told = { ...told, paused: still };
      if (still) element.pause();
      else void element.play().catch(() => {});
    }
    const at = nearbyTime();
    if (element.seeking || !Number.isFinite(at)) return;
    // Ahead of the screen when positive.
    const drift = element.currentTime - at;
    if (Math.abs(drift) > (still ? PAUSED_DRIFT_S : JUMP_S)) {
      told = { ...told, time: at };
      element.currentTime = at;
      element.playbackRate = 1;
      return;
    }
    element.playbackRate = still || Math.abs(drift) < DRIFT_S ? 1 : 1 - Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, drift / 4));
  };
  const stop = effect(() => {
    void nearbyPlayback.value;
    void nearbyScreen.value;
    follow();
  });
  // An element taken from the page, or a page put away, pauses by itself; that is not the person's pause.
  const own = () => element.isConnected && !document.hidden && here();
  const settle = () => {
    settleUntil = performance.now() + SETTLE_MS;
    clearTimeout(settled);
    settled = setTimeout(follow, SETTLE_MS);
  };
  // Told whatever the screen last said: a pause it has not yet heard of is followed by a play at
  // once when the timeline is dragged, and a play or pause it already has does nothing.
  const onPlay = () => {
    if (told.paused === false) return void delete told.paused;
    if (own()) (settle(), playNearby());
  };
  const onPause = () => {
    if (told.paused === true) return void delete told.paused;
    if (own() && !element.ended) (settle(), pauseNearby());
  };
  const onSeeked = () => {
    if (told.time !== undefined && Math.abs(element.currentTime - told.time) < 1) return void delete told.time;
    if (own()) (settle(), seekNearbyTo(element.currentTime));
  };
  element.addEventListener('play', onPlay);
  element.addEventListener('pause', onPause);
  element.addEventListener('seeked', onSeeked);
  return () => {
    stop();
    clearTimeout(settled);
    element.removeEventListener('play', onPlay);
    element.removeEventListener('pause', onPause);
    element.removeEventListener('seeked', onSeeked);
    element.muted = muted;
    element.playbackRate = 1;
  };
};
