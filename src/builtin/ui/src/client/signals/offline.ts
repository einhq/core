/**
 * What the Web UI keeps on this device to open and be read while EiN is out of reach
 * (ein/core#1522): the service worker (`sw/sw.ts`) keeps the Web UI and the pictures and documents
 * opened recently, and the shell client keeps the answers to reads (`lib/saved-answers.ts`).
 *
 * What is kept is one signed-in reader's: it is emptied when they sign out, and when the page finds
 * anyone else reading, so no account finds another's. Nothing is written while EiN is out of reach;
 * a change fails as it is asked for.
 */

import { effect } from '@preact/signals-react';
import type { Whoami } from '@ein/api';
import { answersKeptFor, forgetAnswers, keepAnswers } from '../lib/saved-answers.ts';
import { FILES_CACHE } from '../sw/caches.ts';
import { notify } from './notify.ts';
import { savedAnswerShown, shellClientConnected } from './shell-client.ts';

/**
 * Who reads, as what is kept is kept for: an account, apart when its sign-in is an administrator's,
 * or null for the guest and for a share link's visitor, for whom nothing is kept.
 */
export const readerOf = (whoami: Whoami): string | null => whoami.username === 'guest' ? null : `${whoami.uid}${whoami.admin ? ':admin' : ''}`;

/** Empty what this device keeps for a reader, the answers and the files, and keep what follows for `next`. */
export async function forgetReader(next: string | null = null): Promise<void> {
  await Promise.all([
    forgetAnswers(next).catch((error) => console.warn('offline: answers not emptied', error)),
    globalThis.caches?.delete(FILES_CACHE),
  ]);
}

/** Keep what this page reads for `reader`, or nothing for null; what was kept for anyone else goes first. */
export async function keepFor(reader: string | null): Promise<void> {
  if ((await answersKeptFor()) !== reader) await forgetReader(reader);
  keepAnswers(reader !== null);
}

/**
 * Register the service worker, where the browser has one: only over HTTPS or on `localhost`, so a
 * page reached by a plain-HTTP address keeps answers but does not open without a connection.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator) || !globalThis.isSecureContext) return;
  navigator.serviceWorker.register('/sw.js').catch((error) => console.warn('offline: no service worker', error));
}

/**
 * Offer to reload a page that shows kept answers once EiN is in reach again: a page that reads once
 * per visit would otherwise go on showing them.
 */
export function watchReconnect(): void {
  let wasConnected = shellClientConnected.peek();
  effect(() => {
    const connected = shellClientConnected.value;
    const shown = savedAnswerShown.peek();
    if (connected && !wasConnected && shown?.path === globalThis.location.pathname) {
      notify({
        message: 'Connected to EiN again. This page still shows what was saved on this device.',
        action: { label: 'Reload', onClick: () => globalThis.location.reload() },
      });
    }
    wasConnected = connected;
  });
}
