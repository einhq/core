import { useEffect } from 'react';

/**
 * Keep the screen awake while `active`.
 *
 * A slideshow, or a dashboard on a wall, runs with nobody touching it, and a phone or a screen
 * dims and locks after a minute of that. The Screen Wake Lock API holds the display; the browser
 * releases the lock on its own whenever the page is hidden, so it is taken again when the
 * page comes back. It only exists in secure contexts (https, or localhost), and a browser
 * that lacks it or refuses it changes nothing — the page just runs without it.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !navigator.wakeLock) return;
    let sentinel: WakeLockSentinel | null = null;
    let stopped = false;

    const acquire = async () => {
      if (stopped || document.visibilityState !== 'visible') return;
      try {
        const lock = await navigator.wakeLock.request('screen');
        // The effect may have been cleaned up while the request was in flight.
        if (stopped) await lock.release();
        else sentinel = lock;
      } catch {
        // Denied by policy or on battery saver; nothing to do.
      }
    };
    const onVisibility = () => void acquire();

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void sentinel?.release().catch(() => undefined);
      sentinel = null;
    };
  }, [active]);
}
