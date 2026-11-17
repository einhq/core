import { useSignals } from '@preact/signals-react/runtime';
import { useEffect, useRef, useState } from 'react';
import { loadShowOnDevices, nearbyScreen, nearbyStream, offersNearby, openNearby, showOnNearby, showOnNearbyFiles, type ShowOnTarget } from '../signals/show-on.ts';

/**
 * A button that shows something on a screen near the browser (Cast, AirPlay): `loading` while its
 * stream starts, `active` while it waits for its screen to be chosen or a screen plays it.
 */
export type NearbyAction = { label: string; icon: string; loading: boolean; active: boolean; onClick: () => void };

/**
 * The cast icon that shows `target` on a screen near the browser (`openNearby`): the browser's
 * picker straight away when it can be, else the dialog; `undefined` while it cannot go to one: no
 * `target`, a browser without remote playback, or no command that streams it.
 */
export function useShowNearby(target: ShowOnTarget | undefined): NearbyAction | undefined {
  useSignals();
  const [pages, files] = [showOnNearby.value, showOnNearbyFiles.value];
  const path = target?.path;
  const page = target?.page;
  const latest = useRef(target);
  latest.current = target;
  // The last answer stands while the next is asked, so stepping through the lightbox keeps the button.
  const [offered, setOffered] = useState(false);

  useEffect(() => {
    void loadShowOnDevices();
  }, []);

  useEffect(() => {
    if (!path || !(pages || files)) return;
    let live = true;
    void offersNearby({ path, page, title: '' }).then((answer) => live && setOffered(answer));
    return () => {
      live = false;
    };
  }, [path, page, pages, files]);

  if (!target || !(pages || files) || !offered) return undefined;
  const stream = nearbyStream.value?.target.path === target.path ? nearbyStream.value.step : undefined;
  const showing = nearbyScreen.value?.target.path === target.path;
  return {
    label: showing ? 'On a screen near you' : 'Show on a screen near you',
    icon: 'cast',
    loading: stream === 'starting' || stream === 'looking',
    active: showing || stream === 'ready',
    onClick: () => latest.current && openNearby(latest.current),
  };
}
