import { useSignals } from '@preact/signals-react/runtime';
import { useEffect } from 'react';
import { loadShowOnDevices, openShowOn, showOnDevices, type ShowOnTarget } from '../signals/show-on.ts';

/**
 * Opens the "Show on" dialog, which gives a file or a page to a screen or speaker EiN reaches;
 * `undefined` while the user has none to write to, so a page offers the action only to those who
 * have one. A screen near the browser is `useShowNearby`'s.
 */
export function useShowOn(): ((target: ShowOnTarget) => void) | undefined {
  useSignals();
  useEffect(() => {
    void loadShowOnDevices();
  }, []);
  return showOnDevices.value?.length ? openShowOn : undefined;
}
