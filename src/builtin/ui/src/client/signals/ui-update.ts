import { effect } from '@preact/signals-react';
import type { UiManifest } from '@ui/ui-cache';
import { UI_MANIFEST_PATH } from '@ui/ui-cache';
import { notifyProgress, type ProgressToast, toasts } from './notify.ts';
import { shellClientEpoch, subscribeNodes } from './shell-client.ts';

/**
 * Reload the page when EiN serves another UI than the one it runs: a new shell after EiN is updated,
 * or other module bundles after a module is installed, updated or removed (ein/core#1441). An open
 * page keeps the code it loaded, and the old shell or an old module's bundle against a newer EiN
 * breaks in ways nobody can tell apart from a bug.
 *
 * It looks when the shell's socket comes back (an update restarts EiN), when the module manifest is
 * written, and when the page is shown again. A change seen while the page is in view raises a toast
 * that counts down to the reload, and each further change starts the count again, so a run of
 * module installs reloads once; closing the toast puts the reload off until the page is next shown
 * or EiN changes again. A page that is hidden reloads as it is shown again.
 */

/** How long the toast counts down before the page reloads. */
const RELOAD_AFTER_MS = 60_000;

/** A manifest's bundles, as a string that changes when any of them does: its runtime and each module's bundle and stylesheet. */
export const manifestBundles = (manifest: UiManifest): string =>
  JSON.stringify([manifest.runtime, ...Object.entries(manifest.modules).map(([module, entry]) => [module, entry.url, entry.css ?? '']).sort()]);

/** The shell bundle a document loads: its module script. */
const shellBundle = (doc: Document): string | null => doc.querySelector('script[type="module"][src]')?.getAttribute('src') ?? null;

/** The module bundles of the first manifest the page read: what its routes load, whatever was read since. */
let pageBundles: string | null = null;

/** Called with each manifest the page reads; the first is the one the page runs. */
export const notePageManifest = (manifest: UiManifest): void => {
  pageBundles ??= manifestBundles(manifest);
};

/**
 * Whether EiN serves another shell or other module bundles than this page runs: undefined when it
 * cannot be told (EiN is down or restarting). The module bundles are compared only once the page
 * has read a manifest; before signing in it may not be able to.
 */
export const uiChanged = async (): Promise<boolean | undefined> => {
  try {
    const page = await fetch('/', { cache: 'no-cache' });
    if (!page.ok) return undefined;
    const served = shellBundle(new DOMParser().parseFromString(await page.text(), 'text/html'));
    if (!served) return undefined;
    if (served !== shellBundle(document)) return true;
    if (pageBundles === null) return false;
    const manifest = await fetch(`/file${UI_MANIFEST_PATH}`, { cache: 'no-cache' });
    if (!manifest.ok) return undefined;
    return manifestBundles(await manifest.json() as UiManifest) !== pageBundles;
  } catch {
    return undefined;
  }
};

/** The toast counting down, while one is. */
let countdown: { toast: ProgressToast; deadline: number; timer: ReturnType<typeof globalThis.setInterval> } | null = null;
/** EiN changed and the page has not reloaded: it does as it is next shown. */
let stale = false;

const secondsLeft = (deadline: number): number => Math.max(0, Math.ceil((deadline - Date.now()) / 1000));

const stopCountdown = (): void => {
  if (!countdown) return;
  globalThis.clearInterval(countdown.timer);
  countdown.toast.dismiss();
  countdown = null;
};

/** Raise the toast, or start its count again. */
const startCountdown = (): void => {
  const deadline = Date.now() + RELOAD_AFTER_MS;
  const message = (seconds: number) => `EiN has been updated. This page reloads in ${seconds} s.`;
  if (countdown) {
    countdown.deadline = deadline;
    countdown.toast.update({ message: message(secondsLeft(deadline)), progress: 1 });
    return;
  }
  const toast = notifyProgress({ message: message(secondsLeft(deadline)), progress: 1, action: { label: 'Reload now', onClick: () => globalThis.location.reload() } });
  const own = {
    toast,
    deadline,
    timer: globalThis.setInterval(() => {
      // Closed by hand: the reload waits for the page to be shown again, or for EiN to change again.
      if (!toasts.peek().some((each) => each.id === toast.id)) {
        globalThis.clearInterval(own.timer);
        if (countdown === own) countdown = null;
        return;
      }
      const left = own.deadline - Date.now();
      if (left > 0) return toast.update({ message: message(secondsLeft(own.deadline)), progress: left / RELOAD_AFTER_MS });
      // Run out while hidden: as the page is shown again.
      if (document.hidden) return;
      stopCountdown();
      globalThis.location.reload();
    }, 1000),
  };
  countdown = own;
};

let checking: Promise<void> | null = null;
let checkAgain = false;

/** Look whether EiN changed, one look at a time: a change while one runs is looked at after it. */
const check = (): Promise<void> => {
  if (checking) {
    checkAgain = true;
    return checking;
  }
  checking = (async () => {
    do {
      checkAgain = false;
      if (await uiChanged() !== true) continue;
      stale = true;
      if (document.hidden) stopCountdown();
      else startCountdown();
    } while (checkAgain);
  })().finally(() => (checking = null));
  return checking;
};

/** A run of writes to the manifest (`ui-build` over several modules) is looked at once. */
const MANIFEST_SETTLE_MS = 1000;

/** Start watching for a change of EiN's UI; once, for the page's life. */
export function watchUiUpdates(): void {
  // The socket comes back after EiN restarted, and the manifest is watched again on the new one:
  // a subscription dies with its socket.
  let unsubscribe: (() => void) | null = null;
  let settle: ReturnType<typeof globalThis.setTimeout> | undefined;
  let firstEpoch: number | null = null;
  effect(() => {
    const epoch = shellClientEpoch.value;
    if (epoch === 0) return;
    unsubscribe?.();
    unsubscribe = null;
    subscribeNodes({ pathPrefix: UI_MANIFEST_PATH, eventTypes: ['created', 'updated'] }, () => {
      globalThis.clearTimeout(settle);
      settle = globalThis.setTimeout(() => void check(), MANIFEST_SETTLE_MS);
    }).then((dispose) => {
      if (shellClientEpoch.peek() === epoch) unsubscribe = dispose;
      else dispose();
    }).catch(() => {
      // The socket is down again; its return subscribes afresh.
    });
    // The first connection is the page's own load: it runs what EiN serves.
    firstEpoch ??= epoch;
    if (epoch !== firstEpoch) void check();
  });

  // Shown again, the page has nothing on it in hand yet: a change reloads it at once.
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) return;
    if (stale || await uiChanged() === true) globalThis.location.reload();
  });
}
