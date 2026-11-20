/**
 * Google Cast from the page itself (the Cast Web Sender SDK, Google's script), for Chrome: a session
 * with a screen near the browser that Google's Default Media Receiver plays in, which is given one
 * thing after another without the picker again, draws a video's captions (a WebVTT track) and
 * shows pictures. The browser's own Remote Playback hands a screen only the source of one video
 * element, with no captions and no pictures, and Chrome on Android lets the screen's media go when
 * that source changes (ein/core#1424); it stays for Safari (AirPlay).
 *
 * The script is fetched from Google the first time this browser casts, and at every start after
 * that, so a page opened again joins the session that plays (`ORIGIN_SCOPED`).
 */

import type { ScreenKey } from '@ein/api';

/** The script, which loads the framework (`cast.framework`) beside the base API (`chrome.cast`). */
const SDK_URL = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';

/** Kept in this browser once it has cast, so the script is loaded at start to join a session that plays. */
const CAST_BEFORE_KEY = 'ein.cast.used';

/**
 * What this browser last gave the screen, by its address: a page opened again knows it by that
 * when the receiver does not give `customData` back with what it plays.
 */
const GIVEN_KEY = 'ein.cast.given';

/** How long the script may take to say whether Cast is there. */
const SDK_LOAD_MS = 10_000;

/** The Cast media protocol's namespace, which what the screen plays is asked and told in. */
const MEDIA_NAMESPACE = 'urn:x-cast:com.google.cast.media';

/** Where the ids of the requests sent here in the media protocol start, apart from the script's own. */
const REQUEST_ID_BASE = 2 ** 30;

// The parts of Google's API used here; the script defines them on `window`.
type CastMediaInfo = {
  contentId: string;
  contentUrl?: string;
  contentType: string;
  streamType?: string;
  metadata?: unknown;
  tracks?: unknown[];
  textTrackStyle?: unknown;
  customData?: unknown;
  /** In seconds, as the receiver tells it. */
  duration?: number;
  hlsSegmentFormat?: string;
  hlsVideoSegmentFormat?: string;
};
type CastMedia = {
  media?: CastMediaInfo;
  activeTrackIds?: number[];
  playerState?: string;
  getEstimatedTime(): number;
  play(request: unknown, ok: () => void, failed: (error: unknown) => void): void;
  pause(request: unknown, ok: () => void, failed: (error: unknown) => void): void;
  seek(request: unknown, ok: () => void, failed: (error: unknown) => void): void;
  editTracksInfo(request: unknown, ok: () => void, failed: (error: unknown) => void): void;
};
type CastSessionApi = {
  loadMedia(request: unknown): Promise<string | undefined>;
  getMediaSession(): CastMedia | null;
  sendMessage(namespace: string, message: unknown): Promise<string | undefined>;
  addMessageListener(namespace: string, listener: (namespace: string, message: unknown) => void): void;
  endSession(stopCasting: boolean): void;
};
type RemotePlayer = {
  isConnected: boolean;
  isMediaLoaded: boolean;
  isPaused: boolean;
  currentTime: number;
  duration: number;
  playerState: string | null;
  mediaInfo: CastMediaInfo | null;
  title: string | null;
};
type CastSessionEvents = CastSessionApi & {
  addEventListener(type: string, listener: (event: { mediaSession?: { addUpdateListener(listener: () => void): void } }) => void): void;
};
type CastContext = {
  setOptions(options: Record<string, unknown>): void;
  requestSession(): Promise<string | undefined>;
  getCurrentSession(): CastSessionApi | null;
  endCurrentSession(stopCasting: boolean): void;
  addEventListener(type: string, listener: (event: { session?: CastSessionEvents; sessionState?: string }) => void): void;
};

/** What the receiver says it plays, in the media protocol: `media` only when it changed, or when asked. */
type MediaStatus = { mediaSessionId: number; playerState?: string; currentTime?: number; playbackRate?: number; activeTrackIds?: number[]; media?: CastMediaInfo };
// deno-lint-ignore no-explicit-any
type Api = any;

type CastWindow = typeof globalThis & { __onGCastApiAvailable?: (available: boolean) => void; cast?: Api; chrome?: Api };
const page = globalThis as CastWindow;

/**
 * One thing for the screen: where it fetches it and its type, its title, whether it is live (a
 * page's stream, with no length), its captions, and what EiN keeps of it there (`custom`).
 */
export type CastItem = {
  url: string;
  type: string;
  title: string;
  live?: boolean;
  /** The WebVTT file the screen draws under a video, shown when `captionsOn`. */
  captions?: string;
  captionsOn: boolean;
  custom: CastCustom;
};

/**
 * What EiN keeps with what the screen plays, so a page opened again knows it: the file or page,
 * its title and kind, where in EiN it was sent from, the id `stream-file` keeps it by, a page's
 * stream and the keys it takes, and when it was given (`at`, in ms), which tells what the screen still reports
 * from what was given since.
 */
export type CastCustom = { path: string; title: string; kind?: string; link: string; page: boolean; id?: string; stream?: string; keys?: ScreenKey[]; at: number };

/** What the screen plays and how far it is, as the framework hears it; `custom` is ours when it plays something EiN gave it. */
export type CastState = {
  connected: boolean;
  paused: boolean;
  time: number;
  duration: number;
  /** The receiver's player: `IDLE`, `PLAYING`, `PAUSED` or `BUFFERING`; `null` while it plays nothing. */
  playerState: string | null;
  custom: CastCustom | null;
};

let loading: Promise<boolean> | undefined;
let context: CastContext | undefined;
let player: RemotePlayer | undefined;
const listeners = new Set<(state: CastState) => void>();

/** Whether the script is there and Cast works in this browser. */
export const castLoaded = (): boolean => context !== undefined;

/** Whether this browser has cast before, so the script is worth loading at start. */
export const castedBefore = (): boolean => {
  try {
    return localStorage.getItem(CAST_BEFORE_KEY) === '1';
  } catch {
    return false;
  }
};

const rememberCast = (): void => {
  try {
    localStorage.setItem(CAST_BEFORE_KEY, '1');
  } catch {
    // A browser that keeps nothing loads the script at the next tap instead.
  }
};

/**
 * Load Google's script and set Cast up, once: true when it works here. A page that is not served
 * over HTTPS, or a browser without Cast (Firefox, Safari), answers false, and the browser's own
 * Remote Playback is used instead.
 */
export const loadCast = (): Promise<boolean> =>
  loading ??= new Promise<boolean>((resolve) => {
    if (!globalThis.isSecureContext || !page.chrome || typeof document === 'undefined') return resolve(false);
    const timer = setTimeout(() => resolve(false), SDK_LOAD_MS);
    page.__onGCastApiAvailable = (available) => {
      clearTimeout(timer);
      if (available && page.cast?.framework) setUp();
      resolve(castLoaded());
    };
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
    document.head.append(script);
  });

const setUp = (): void => {
  const framework = page.cast.framework;
  const instance = framework.CastContext.getInstance() as CastContext;
  instance.setOptions({
    receiverApplicationId: page.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    autoJoinPolicy: page.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
  });
  const remote = new framework.RemotePlayer() as RemotePlayer;
  const controller = new framework.RemotePlayerController(remote);
  controller.addEventListener(framework.RemotePlayerEventType.ANY_CHANGE, tell);
  // A session joined, as by a page opened again, may come to know what the screen plays only
  // through its media session, which the player above does not always hear of. The receiver tells
  // a sender that joins nothing of what it plays until that changes, so it is asked; where the
  // script makes no media session of the answer, the answer itself is what is known.
  const { SESSION_STARTED, SESSION_RESUMED, SESSION_ENDED } = framework.SessionState;
  instance.addEventListener(framework.CastContextEventType.SESSION_STATE_CHANGED, (event) => {
    const session = event.session;
    if (session && !heardSessions.has(session)) {
      heardSessions.add(session);
      session.addEventListener(framework.SessionEventType.MEDIA_SESSION, (found) => {
        found.mediaSession?.addUpdateListener(tell);
        tell();
      });
      session.addMessageListener(MEDIA_NAMESPACE, hearStatus);
    }
    if (event.sessionState === SESSION_ENDED) heard = undefined;
    if (session && (event.sessionState === SESSION_STARTED || event.sessionState === SESSION_RESUMED)) {
      heard = undefined;
      send(session, { type: 'GET_STATUS' });
    }
    tell();
  });
  context = instance;
  player = remote;
  tell();
};

/** The sessions whose media this hears. */
const heardSessions = new WeakSet<CastSessionEvents>();

/** What the receiver last said it plays, in the media protocol, and when (`performance.now()`). */
let heard: { status: MediaStatus; at: number } | undefined;

let requests = REQUEST_ID_BASE;

/** Send the receiver `message` in the media protocol; what it answers is heard by `hearStatus`. */
const send = (session: CastSessionApi, message: Record<string, unknown>): void => {
  try {
    void Promise.resolve(session.sendMessage(MEDIA_NAMESPACE, { ...message, requestId: ++requests })).catch(() => {});
  } catch {
    // Not sent; the screen is known only through the script, then.
  }
};

/** A media status from the receiver: what it plays, its `media` kept from the last one while the same plays. */
const hearStatus = (_namespace: string, message: unknown): void => {
  let said: { type?: string; status?: MediaStatus[] };
  try {
    said = typeof message === 'string' ? JSON.parse(message) : message as typeof said;
  } catch {
    return;
  }
  if (said?.type !== 'MEDIA_STATUS' || !Array.isArray(said.status)) return;
  const status = said.status[0];
  const media = status?.media ?? (heard?.status.mediaSessionId === status?.mediaSessionId ? heard?.status.media : undefined);
  heard = status ? { status: { ...status, media }, at: performance.now() } : undefined;
  tell();
};

const isCustom = (custom: unknown): custom is CastCustom => {
  const each = custom as Partial<CastCustom> | null | undefined;
  return typeof each?.path === 'string' && typeof each.title === 'string' && typeof each.at === 'number';
};

const rememberGiven = (url: string, custom: CastCustom): void => {
  try {
    localStorage.setItem(GIVEN_KEY, JSON.stringify({ url, custom }));
  } catch {
    // Kept only by the receiver, then.
  }
};

/** What this browser last gave the screen, when the screen plays it: by its address, or by its title where the receiver gives back no address. */
const given = (info: CastMediaInfo | null | undefined, title: string | null | undefined): CastCustom | null => {
  try {
    const kept = JSON.parse(localStorage.getItem(GIVEN_KEY) ?? 'null') as { url?: string; custom?: unknown } | null;
    if (!kept?.url || !isCustom(kept.custom)) return null;
    const metadata = info?.metadata as { title?: unknown } | undefined;
    const same = kept.url === info?.contentId || kept.url === info?.contentUrl || kept.custom.title === (title || metadata?.title);
    return same ? kept.custom : null;
  } catch {
    return null;
  }
};

/**
 * What this browser last gave the screen, whatever the screen says it plays: a page's stream, whose
 * live video a receiver joined again may not name, is known by asking EiN whether it still runs.
 */
export const lastGiven = (): CastCustom | null => {
  try {
    const kept = JSON.parse(localStorage.getItem(GIVEN_KEY) ?? 'null') as { custom?: unknown } | null;
    return isCustom(kept?.custom) ? kept.custom : null;
  } catch {
    return null;
  }
};

const forgetGiven = (): void => {
  try {
    localStorage.removeItem(GIVEN_KEY);
  } catch {
    // Nothing was kept.
  }
};

const customOf = (info: CastMediaInfo | null | undefined, title: string | null | undefined): CastCustom | null =>
  isCustom(info?.customData) ? info.customData : given(info, title);

/** What the screen plays now; disconnected while the script is not there. */
const castState = (): CastState => {
  const remote = player;
  if (!remote?.isConnected) return { connected: false, paused: true, time: 0, duration: NaN, playerState: null, custom: null };
  if (remote.isMediaLoaded) {
    return {
      connected: true,
      paused: remote.isPaused || remote.playerState === 'IDLE',
      time: remote.currentTime,
      duration: remote.duration > 0 ? remote.duration : NaN,
      playerState: remote.playerState,
      custom: customOf(remote.mediaInfo, remote.title),
    };
  }
  // What the player has not heard of, the media session may know, or else the receiver's own answer.
  const media = context?.getCurrentSession()?.getMediaSession();
  if (media) return playingState(media.playerState, media.getEstimatedTime(), media.media);
  if (!heard) return playingState(undefined, 0, undefined);
  const { status, at } = heard;
  const since = status.playerState === 'PLAYING' ? (performance.now() - at) / 1000 * (status.playbackRate ?? 1) : 0;
  return playingState(status.playerState, (status.currentTime ?? 0) + since, status.media);
};

/** A connected screen's state from its player's `state`, where it is and what it plays. */
const playingState = (state: string | undefined, time: number, info: CastMediaInfo | undefined): CastState => {
  if (!state || state === 'IDLE') return { connected: true, paused: true, time: 0, duration: NaN, playerState: null, custom: null };
  const duration = info?.duration ?? NaN;
  return { connected: true, paused: state === 'PAUSED', time, duration: duration > 0 ? duration : NaN, playerState: state, custom: customOf(info, null) };
};

const tell = (): void => {
  const state = castState();
  for (const listener of listeners) listener(state);
};

/** Hear what the screen plays and how far it is, at once and whenever it changes; the answer stops hearing. */
export const onCast = (listener: (state: CastState) => void): () => void => {
  listeners.add(listener);
  listener(castState());
  return () => listeners.delete(listener);
};

/**
 * Chrome's picker of the screens near the browser, from a tap: resolves once a session has started
 * with one. Rejects with the framework's word: `cancel` when the picker was closed.
 */
export const requestCast = async (): Promise<void> => {
  if (!context) throw new Error('Cast is not loaded');
  const failed = await context.requestSession();
  if (failed) throw new Error(failed);
  rememberCast();
};

/** Whether a session with a screen is there, to be given something without the picker. */
export const castConnected = (): boolean => player?.isConnected === true && context?.getCurrentSession() != null;

/** The captions track's id. */
const CAPTIONS_ID = 1;

/**
 * Give the screen in the session `item` in place of what it plays: a picture is shown, a
 * recording or video played from `start` seconds, with its captions when it has them, and a page's
 * live video as live, which the receiver plays from its newest part, with no length. Rejects with
 * the receiver's word when it cannot load it.
 */
export const castLoad = async (item: CastItem, start = 0): Promise<void> => {
  const session = context?.getCurrentSession();
  if (!session) throw new Error('no screen is connected');
  const media = page.chrome.cast.media;
  const info = new media.MediaInfo(item.url, item.type) as CastMediaInfo;
  info.contentUrl = item.url;
  info.streamType = item.live ? media.StreamType.LIVE : media.StreamType.BUFFERED;
  const picture = item.type.startsWith('image/');
  const metadata = picture ? new media.PhotoMediaMetadata() : new media.GenericMediaMetadata();
  metadata.title = item.title;
  info.metadata = metadata;
  // HLS the media service makes goes as MPEG-TS segments, which the receiver assumes only when told.
  if (/mpegurl/i.test(item.type)) {
    info.hlsSegmentFormat = media.HlsSegmentFormat.TS;
    info.hlsVideoSegmentFormat = media.HlsVideoSegmentFormat.MPEG2_TS;
  }
  if (item.captions) {
    const track = new media.Track(CAPTIONS_ID, media.TrackType.TEXT);
    Object.assign(track, { trackContentId: item.captions, trackContentType: 'text/vtt', subtype: media.TextTrackType.SUBTITLES, name: 'Transcript', language: 'und' });
    info.tracks = [track];
    const style = new media.TextTrackStyle();
    Object.assign(style, { backgroundColor: '#00000099', foregroundColor: '#FFFFFFFF', edgeType: media.TextTrackEdgeType.NONE, fontScale: 1 });
    info.textTrackStyle = style;
  }
  info.customData = item.custom;
  const request = new media.LoadRequest(info);
  request.autoplay = true;
  if (!picture && !item.live) request.currentTime = start;
  if (item.captions && item.captionsOn) request.activeTrackIds = [CAPTIONS_ID];
  const failed = await session.loadMedia(request);
  if (failed) throw new Error(failed);
  rememberGiven(item.url, item.custom);
};

/**
 * Call one of the media session's methods, or, where the script made none of what the receiver
 * said it plays, send it `message` in the media protocol; nothing when the screen plays nothing.
 */
const command = (call: (media: CastMedia) => void, message: Record<string, unknown>): void => {
  const session = context?.getCurrentSession();
  const media = session?.getMediaSession();
  if (media) call(media);
  else if (session && heard) send(session, { ...message, mediaSessionId: heard.status.mediaSessionId });
};

const ignore = () => {};

export const castPlay = (): void => command((media) => media.play(new page.chrome.cast.media.PlayRequest(), ignore, ignore), { type: 'PLAY' });

export const castPause = (): void => command((media) => media.pause(new page.chrome.cast.media.PauseRequest(), ignore, ignore), { type: 'PAUSE' });

/** Move what the screen plays to `seconds`. */
export const castSeek = (seconds: number): void => {
  const at = Math.max(0, seconds);
  command((media) => {
    const request = new page.chrome.cast.media.SeekRequest();
    request.currentTime = at;
    media.seek(request, ignore, ignore);
  }, { type: 'SEEK', currentTime: at });
};

/** Show or hide the captions of what the screen plays, when it has them. */
export const castCaptions = (on: boolean): void => {
  const media = context?.getCurrentSession()?.getMediaSession();
  const playing = media ?? heard?.status;
  if (!playing?.media?.tracks?.length) return;
  const shown = playing.activeTrackIds?.includes(CAPTIONS_ID) ?? false;
  if (shown === on) return;
  const ids = on ? [CAPTIONS_ID] : [];
  command((each) => each.editTracksInfo(new page.chrome.cast.media.EditTracksInfoRequest(ids), ignore, ignore), { type: 'EDIT_TRACKS_INFO', activeTrackIds: ids });
};

/** End the session: the screen goes back to its own. */
export const castStop = (): void => {
  forgetGiven();
  heard = undefined;
  context?.endCurrentSession(true);
};
