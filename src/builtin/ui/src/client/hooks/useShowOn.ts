import { useSignals } from '@preact/signals-react/runtime';
import { useEffect } from 'react';
import { loadShowOnDevices, openShowOn, showOnDevices, showOnNearby, showOnNearbyFiles, type ShowOnTarget } from '../signals/show-on.ts';

/**
 * Opens the "Show on" dialog, which gives a file or a page to a screen or speaker; `undefined` while
 * the user has none to write to and no screen near the browser, so a page offers the action only to
 * those who have one.
 */
export function useShowOn(): ((target: ShowOnTarget) => void) | undefined {
  useSignals();
  useEffect(() => {
    void loadShowOnDevices();
  }, []);
  return showOnDevices.value?.length || showOnNearby.value || showOnNearbyFiles.value ? openShowOn : undefined;
}
