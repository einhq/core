/**
 * The EiN app's bridge: `window.EinApp`, which the Android app gives the pages of the server it is
 * paired with in its WebView, and no other page. A browser has none, so `inEinApp()` is how a page
 * tells the app from a browser.
 *
 * A call is a JSON message `{ "id": 1, "method": "info", "params": {} }` posted to it; the app
 * answers on the same object with `{ "id": 1, "result": … }` or `{ "id": 1, "error": "…" }`.
 *
 * The kit lends it to module pages too: a module gives the App page where the photo backup sends
 * (an `app.backup` panel), and says so with `appBackupSet`. The position reports are the App page's
 * alone.
 */

/** What the app's WebView puts on `window` (a web message listener's object). */
type Bridge = {
  postMessage(message: string): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
};

/** `info`'s answer: the app and its pairing. */
export type EinAppInfo = {
  /** The app's version (`0.1.0`). */
  version: string;
  /** The EiN it is paired with, as its origin (`https://ein.example`). */
  server: string;
  /** The phone's device name. */
  device: string;
  /** The account the app signs in as. */
  user: string;
};

/** One of the phone's folders of photos and videos, as the backup offers it. */
export type EinAppBackupFolder = {
  /** Where it is on the phone, which also names it in `backupSet` (`DCIM/Camera/`). */
  path: string;
  /** Its own name (`Camera`). */
  name: string;
  /** The photos and videos in it the app may see. */
  count: number;
  /** Whether the backup sends it. */
  chosen: boolean;
};

/** Where the backup sends: a folder of the paired account's, and what to call it. */
export type EinAppBackupInto = { dir: string; label: string };

/** `backup`'s answer: the photo backup's settings, what the app may read, and how far it is. */
export type EinAppBackup = {
  /** Whether the backup is on. It runs only with somewhere to send to (`into`) and photos it may read. */
  enabled: boolean;
  into?: EinAppBackupInto;
  folders: EinAppBackupFolder[];
  /** Send only over Wi-Fi (an unmetered network), and only while the phone charges. */
  wifiOnly: boolean;
  chargingOnly: boolean;
  /** Which photos and videos the app may read: all, only those the person picked, or none. */
  access: 'all' | 'partial' | 'none';
  /** Whether it may read where a photo was taken; without it, Android takes the place out of every photo it reads. */
  location: boolean;
  /** Photos and videos in the chosen folders not sent yet, and those sent or found on EiN already. */
  waiting: number;
  sent: number;
  /** Whether a backup runs now, and the file it is sending, with how many of its bytes are sent. */
  running: boolean;
  current?: { name: string; sent: number; size: number };
  /** What holds a backup that is on back now: no Wi-Fi, not charging, or no network at all. */
  waitingFor?: 'wifi' | 'charging' | 'network';
  /** When the last backup ended, and why it failed when it did. */
  lastRun?: string;
  lastError?: string;
};

/** What `backupSet` changes; what it leaves out stays as it is. */
export type EinAppBackupChange = {
  enabled?: boolean;
  into?: EinAppBackupInto | null;
  /** The chosen folders, by their `path`. */
  folders?: string[];
  wifiOnly?: boolean;
  chargingOnly?: boolean;
};

/** `tracking`'s answer: the position reports' settings, what the app may know, and how they go. */
export type EinAppTracking = {
  /** Whether the reports are on. They run only while the app may know the phone's position (`access`). */
  enabled: boolean;
  /** Whether the app asks for the phone's precise position (its GPS) rather than the balanced one, which spares the battery. */
  precise: boolean;
  /** When the app may know the phone's position: never, only while it is in use, or all the time. */
  access: 'none' | 'in-use' | 'always';
  /** Whether the phone gives the app only its approximate position. */
  approximate: boolean;
  /** Whether the app may tell when the phone moves, to pause while it lies still. */
  motion: boolean;
  /** Whether the app may show its notification while it reports. */
  notifications: boolean;
  /** Whether the app's service runs now, and whether it pauses because the phone lies still. */
  running: boolean;
  still: boolean;
  /** What the phone was last doing (`still`, `walking`, `running`, `on_bicycle`, `in_vehicle`). */
  activity?: string;
  /** When the last position was taken, and how sure it was, in metres. */
  lastFix?: string;
  accuracy?: number;
  /** Positions taken and not sent yet, which the phone keeps while it is offline. */
  queued: number;
  /** When positions last reached EiN, and why the last send failed when it did. */
  lastSent?: string;
  lastError?: string;
  /** What holds the waiting positions back: no connection. */
  waitingFor?: 'network';
};

/** What `trackingSet` changes; what it leaves out stays as it is. */
export type EinAppTrackingChange = { enabled?: boolean; precise?: boolean };

/** How long a call waits for the app's answer: `unpair` asks the server, which may be slow to answer. */
const ANSWER_MS = 30_000;

/** How long `backupAllow` waits: the phone's owner answers Android's questions first. */
const ALLOW_MS = 10 * 60_000;

const bridge = (): Bridge | undefined => (globalThis as { EinApp?: Bridge }).EinApp;

/** Whether this page is in the EiN app's WebView. */
export const inEinApp = (): boolean => bridge() !== undefined;

let nextId = 1;
const waiting = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
let listening = false;

const onAnswer = (event: MessageEvent) => {
  let answer: { id?: unknown; result?: unknown; error?: unknown };
  try {
    answer = JSON.parse(String(event.data));
  } catch {
    return;
  }
  const call = typeof answer.id === 'number' ? waiting.get(answer.id) : undefined;
  if (!call) return;
  waiting.delete(answer.id as number);
  if (answer.error !== undefined) call.reject(new Error(String(answer.error)));
  else call.resolve(answer.result);
};

/** Ask the app to do `method`; rejects outside the app, on its error, or when it does not answer. */
function appCall<T>(method: string, params: Record<string, unknown> = {}, waitMs = ANSWER_MS): Promise<T> {
  const app = bridge();
  if (!app) return Promise.reject(new Error('not in the EiN app'));
  if (!listening) {
    app.addEventListener('message', onAnswer);
    listening = true;
  }
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`the app did not answer ${method}`));
    }, waitMs);
    waiting.set(id, {
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result as T);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    app.postMessage(JSON.stringify({ id, method, params }));
  });
}

/** The app's version and its pairing. */
export const appInfo = (): Promise<EinAppInfo> => appCall<EinAppInfo>('info');

/**
 * Have the app take its pairing away, with its own token rather than this page's session, which
 * unpairing ends: it then forgets the pairing and shows its pairing screen. Rejects with why when
 * it could not.
 */
export const appUnpair = (): Promise<void> => appCall<void>('unpair');

/** The photo backup: its settings, what the app may read, and how far it is. */
export const appBackup = (): Promise<EinAppBackup> => appCall<EinAppBackup>('backup');

/** Change the photo backup's settings; answers them as they are then. */
export const appBackupSet = (change: EinAppBackupChange): Promise<EinAppBackup> => appCall<EinAppBackup>('backupSet', { ...change });

/**
 * Have the app ask the phone's owner for what the backup needs: its photos and videos, where they
 * were taken, and a notification while it sends. Answers once they have chosen.
 */
export const appBackupAllow = (): Promise<EinAppBackup> => appCall<EinAppBackup>('backupAllow', {}, ALLOW_MS);

/** Start a backup now, under the backup's conditions (Wi-Fi, charging). */
export const appBackupNow = (): Promise<EinAppBackup> => appCall<EinAppBackup>('backupNow');

/** The position reports: their settings, what the app may know, and how they go. */
export const appTracking = (): Promise<EinAppTracking> => appCall<EinAppTracking>('tracking');

/** Change the position reports' settings; answers them as they are then. */
export const appTrackingSet = (change: EinAppTrackingChange): Promise<EinAppTracking> => appCall<EinAppTracking>('trackingSet', { ...change });

/**
 * Have the app ask the phone's owner for what the reports need: the position while the app is in
 * use, how the phone moves and a notification, then, once the app has said why, the position all
 * the time. Answers once they have chosen.
 */
export const appTrackingAllow = (): Promise<EinAppTracking> => appCall<EinAppTracking>('trackingAllow', {}, ALLOW_MS);

/** Send the waiting positions now. */
export const appTrackingSend = (): Promise<EinAppTracking> => appCall<EinAppTracking>('trackingSend');
