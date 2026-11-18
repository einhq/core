import { ActionIcon, Tooltip } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { useEffect } from 'react';
import { joinNearby, nearbyCast, nearbyDialog, nearbyPlayback, nearbyScreen } from '../../signals/show-on.ts';
import { TablerIcon } from '../Icon/TablerIcon.tsx';

/**
 * The top bar's cast icon while a screen near the browser plays something of ours, or Cast holds
 * one, in the accent colour: it opens the dialog with what plays, its controls and a way back to
 * where it was sent from, or, with nothing of ours known to play, the way to disconnect. Mounted
 * with the top bar, it joins the Cast session that plays when the app starts.
 */
export function NearbyIndicator({ phone }: { phone: boolean }) {
  useSignals();
  useEffect(joinNearby, []);
  const screen = nearbyScreen.value;
  if (!screen && !nearbyCast.value) return null;
  const playing = !nearbyPlayback.value.paused;
  const label = screen ? `${playing ? 'Playing' : 'Paused'} on a screen near you: ${screen.target.title}` : 'Connected to a screen near you';
  return (
    <Tooltip label={label}>
      <ActionIcon
        variant='subtle'
        color='gray'
        size={phone ? 36 : undefined}
        aria-label={label}
        data-nearby-indicator
        onClick={() => {
          nearbyDialog.value = screen?.target ?? { path: '', title: '' };
        }}
      >
        <TablerIcon name='cast' size={phone ? 22 : 18} color='var(--mrx-accent)' />
      </ActionIcon>
    </Tooltip>
  );
}
