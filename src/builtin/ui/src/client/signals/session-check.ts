import { effect } from '@preact/signals-react';
import { loginUrlFor } from '../lib/login-return.ts';
import { shellClientEpoch } from './shell-client.ts';
import { isAuthenticated } from './user.ts';

/** How often at most a navigation or a failed picture asks the server again. */
const CHECK_INTERVAL_MS = 60_000;

/** When the server was last asked; the document's own response wrote the cookie at load. */
let lastCheck = Date.now();
let checking = false;

/**
 * Ask the server whether this browser's cookie still signs it in (`GET /__session`), for someone
 * signed in. The shell's socket keeps the access it opened with, but the pictures, downloads and
 * uploads are HTTP requests that carry the cookie, and the cookie dies a lifetime after it was last
 * written. The answer writes it again, so a page in use keeps it.
 *
 * When it no longer signs in — it expired while the page sat unused, or the session ended — the
 * page is loaded again on the login page: a new document gets the browser a new session to sign in,
 * where an in-page move would keep the old socket, still signed in. Signing in returns to the page
 * the reader was on.
 *
 * At most once a `CHECK_INTERVAL_MS` unless `force`d.
 */
export async function checkSession(force = false): Promise<void> {
  if (!isAuthenticated.value || checking) return;
  if (!force && Date.now() - lastCheck < CHECK_INTERVAL_MS) return;
  checking = true;
  lastCheck = Date.now();
  try {
    const response = await fetch('/__session', { cache: 'no-store' });
    if (response.status === 401 && isAuthenticated.value) {
      const { pathname, search, hash } = globalThis.location;
      globalThis.location.replace(loginUrlFor(pathname + search + hash));
    }
  } catch {
    // Offline: the next check asks again.
  } finally {
    checking = false;
  }
}

/**
 * Check the session whenever the reader may have been away or something failed to load for want of
 * it: when the tab is shown again, when a picture or a video fails, and when the shell's socket
 * comes back, which it does as the guest when its session ended meanwhile. Navigating checks too,
 * from the page frame. Returns the function that stops watching.
 */
export function watchSession(): () => void {
  const onVisible = () => {
    if (document.visibilityState === 'visible') void checkSession();
  };
  // A failed load does not bubble; it is caught on its way down.
  const onError = (event: Event) => {
    if (event.target instanceof HTMLImageElement || event.target instanceof HTMLMediaElement) void checkSession();
  };
  document.addEventListener('visibilitychange', onVisible);
  document.addEventListener('error', onError, true);
  const epoch = shellClientEpoch.peek();
  const stopEpoch = effect(() => {
    if (shellClientEpoch.value !== epoch) void checkSession(true);
  });
  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    document.removeEventListener('error', onError, true);
    stopEpoch();
  };
}
