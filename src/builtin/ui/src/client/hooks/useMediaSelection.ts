import { useMemo } from 'react';
import { useHotkeys } from '@mantine/hooks';
import { useShortcutHelp } from './useShortcutHelp.ts';
import type { MediaItem } from '../signals/album.ts';
import { isLightboxOpen } from '../signals/album.ts';
import { type Selection, type SelectionMods, useSelection } from './useSelection.ts';

export type { SelectionMods };

export type MediaSelection = Selection & {
  /** Selected paths in list order, pruned to what is currently on screen. */
  paths: string[];
  toggle: (path: string, mods?: SelectionMods) => void;
};

/**
 * Multi-select over a flat list of media.
 *
 * Keyed by the media path rather than the node id: every action that follows (`rm`,
 * download) needs a path, and a path survives a refetch that mints new objects. The file's
 * own path, specifically — an album that links its members gives the same picture a second
 * path (`memberPath`), and only removing it from that album acts on that one.
 *
 * Owned above the grids, not inside one, so a shift-range in a timeline can span month
 * groups — each group renders its own grid, but they share this list.
 */
const MEDIA_GRID_SHORTCUTS = [
  { keys: 'shift+click', label: 'Select everything from the last picked' },
  { keys: 'mod+click', label: 'Add or take one picture from the selection' },
  { keys: 'mod+A', label: 'Select all' },
  { keys: 'Esc', label: 'Clear the selection' },
  { keys: 'Enter', label: 'Open the focused picture' },
];

export function useMediaSelection(items: MediaItem[]): MediaSelection {
  const paths = useMemo(() => items.map((item) => item.path), [items]);
  const selection = useSelection(paths);

  // The lightbox binds Escape too, and useHotkeys listens on document — so with a picture
  // open, Escape must close it and leave the selection alone. Not prevented: the full-screen
  // surface closes on an Escape nobody took, and before the lightbox's own hotkey has mounted
  // a prevented one would leave it open.
  useHotkeys([
    ['Escape', () => !isLightboxOpen.value && selection.clear(), { preventDefault: false }],
    ['mod+A', () => !isLightboxOpen.value && selection.selectAll()],
  ]);
  useShortcutHelp('Pictures', MEDIA_GRID_SHORTCUTS);

  return { ...selection, paths: selection.keys };
}
