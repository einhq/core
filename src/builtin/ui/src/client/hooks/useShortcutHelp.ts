import { useEffect } from 'react';
import { registerShortcutHelp, type ShortcutHelp } from '../signals/shortcuts.ts';

/**
 * Say what a component's keys do, for the `?` overlay, for as long as it is mounted: the lightbox's
 * keys are listed while a picture is open, the grid's while a grid is on screen. Only the help;
 * the component binds the keys itself. `entries` is read once, at mount.
 */
export function useShortcutHelp(group: string, entries: readonly ShortcutHelp[]): void {
  useEffect(() => registerShortcutHelp(group, entries), [group]);
}
