import { signal } from '@preact/signals-react';
import type { ConfigEntry, ControlAnswer, DeviceSummary, StreamedFile, StreamedPage } from '@ein/api';
import { fileUrl } from '../lib/file-url.ts';
import { shq } from '../lib/shquote.ts';
import { execCommand } from './shell-client.ts';
import { currentUser } from './user.ts';

/**
 * What a screen or speaker is to show or play: the path of a file, or of a page as the address bar
 * has it (`/media?q=sailboat&slideshow=screen`), and what to call it. A file that is not a recording
 * or a video, such as a picture, may name the page that shows it (`page`), which a screen near the
 * browser is given instead, since a browser hands such a screen only a video.
 */
export type ShowOnTarget = { path: string; title: string; page?: string };

/**
 * What the "Show on" dialog is open for, or `null`. Held here, as the sharing dialog is, so a menu
 * item can open it: the menu's dropdown is unmounted by the same click.
 */
export const showOnTarget = signal<ShowOnTarget | null>(null);

export function openShowOn(target: ShowOnTarget) {
  showOnTarget.value = target;
}

/** Close the dialog, letting go of a stream made for a screen near the browser that none took. */
export function closeShowOn() {
  showOnTarget.value = null;
  releaseNearby();
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
  const devices = execCommand<DeviceSummary[]>('devices --endpoint show').then(
    (devices) => {
      showOnDevices.value = devices;
    },
    () => {
      showOnDevices.value = [];
    },
  );
  const setting = (key: string, into: typeof showOnNearby) =>
    'remote' in HTMLMediaElement.prototype
      ? execCommand<ConfigEntry>(`config get ${key}`).then(
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

/** What `target` goes to a screen near the browser as: a page, by its route, or a recording or video. */
type NearbyForm = { page: string } | { file: string };

const nearbyForm = async (target: ShowOnTarget): Promise<NearbyForm | undefined> => {
  if (await isPage(target)) return showOnNearby.value ? { page: target.path } : undefined;
  const node = await execCommand<{ attrs?: { mimetype?: unknown } }>(`stat ${shq(target.path)}`).catch(() => undefined);
  const mimetype = typeof node?.attrs?.mimetype === 'string' ? node.attrs.mimetype : '';
  if (/^(audio|video)\//.test(mimetype)) return showOnNearbyFiles.value ? { file: target.path } : undefined;
  return target.page && showOnNearby.value ? { page: target.page } : undefined;
};

/** Whether `target` can go to a screen near the browser: a page, a recording or video, or a file that names its page. */
export const offersNearby = async (target: ShowOnTarget): Promise<boolean> => (await nearbyForm(target)) !== undefined;

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

/** What the screen near the browser shows, by its title, once a screen has taken it; `null` while it shows nothing of ours. */
export const nearbyShowing = signal<string | null>(null);

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
  // Once a screen takes it, play there; the browser carries play and pause over.
  video.remote.addEventListener('connect', () => {
    nearbyShowing.value = video.title || null;
    void video.play().catch(() => {});
  });
  video.remote.addEventListener('disconnect', () => {
    nearbyShowing.value = null;
    releaseFile();
  });
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

/** How long the browser is given to find a screen for a source it has just been offered. */
const FIND_SCREEN_MS = 5_000;

/** Wait until the browser says a screen takes the stream, or `FIND_SCREEN_MS`; the picker opened before it has looked finds none. */
const screenFound = (): Promise<void> =>
  new Promise((resolve) => {
    if (nearbyAvailable) return resolve();
    const done = () => {
      clearTimeout(timer);
      onAvailable.delete(done);
      resolve();
    };
    const timer = setTimeout(done, FIND_SCREEN_MS);
    onAvailable.add(done);
  });

/**
 * The form of a page's stream the browser hands a screen: Safari (AirPlay) takes the live HLS;
 * Chrome hands a Cast screen no HLS on Android, nor an endless MP4, which it counts as long as it
 * has read, so it gets the MP4 whose header says it lasts a day.
 */
const pageSource = (page: StreamedPage): string => 'WebKitPlaybackTargetAvailabilityEvent' in globalThis ? page.hls : page.remote;

/** How often what EiN keeps for the screen near the browser is renewed: it is let go of five minutes after the last time. */
const RENEW_MS = 60_000;

/** The recording or video EiN keeps for the screen near the browser, by `stream-file`'s id, while this renews it. */
let heldFile: { id: string; timer: ReturnType<typeof setInterval> } | undefined;

const holdFile = (id: string): void => {
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
 * kept while this renews it. Then wait until its player has read the start, after which
 * `chooseNearby` lets the person pick the screen.
 */
export const streamNearby = async (target: ShowOnTarget): Promise<void> => {
  const form = await nearbyForm(target);
  if (!form) throw new Error(`${target.title} cannot go to a screen near you`);
  let source: string;
  let held: string | undefined;
  if ('page' in form) {
    source = pageSource(await execCommand<StreamedPage>(`stream-page ${shq(form.page)}`));
  } else {
    const file = await execCommand<StreamedFile>(`stream-file ${shq(form.file)}`);
    source = file.url;
    held = file.id;
  }
  const video = nearby();
  // A screen still held, by what it played before or by a stream that has ended, is let go: each
  // showing is chosen anew.
  endSession(video);
  video.src = new URL(source, location.origin).href;
  video.title = target.title;
  if (held) holdFile(held);
  else releaseFile();
  try {
    await loaded(video);
  } catch (error) {
    stopNearby();
    throw error;
  }
  offerAgain(video);
  await screenFound();
};

/**
 * The browser's own picker of the screens near it; once one plays the stream it offers to stop.
 * Must be called from a tap (`InvalidAccessError` without one); `NotAllowedError` is the picker
 * dismissed, and `NotFoundError` no screen near the browser that takes the stream. A browser that
 * offers the stream to none cancels the picker at once, as if dismissed: unless it said a screen
 * takes it, that is a `NotFoundError` too, whose message keeps the browser's own words, or a
 * `NotSupportedError` for a recording or video too short for Chrome to offer. Given up with no
 * screen playing it, what was made is let go of.
 */
export const chooseNearby = (): Promise<void> => {
  const video = nearby();
  return video.remote.prompt().catch((error) => {
    const name = error instanceof DOMException ? error.name : '';
    const duration = video.duration;
    const short = duration < MIN_OFFERED_S;
    if (name !== 'InvalidAccessError') releaseNearby();
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
  nearbyShowing.value = null;
};
