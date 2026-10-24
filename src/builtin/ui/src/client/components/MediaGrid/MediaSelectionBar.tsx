import { ActionBar, Button, Menu, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconChevronUp, IconDownload, IconLinkOff, IconTrash } from '@tabler/icons-react';
import { type ReactNode, useMemo, useState } from 'react';
import type { MediaItem } from '../../signals/album.ts';
import { closeLightboxWithoutReturn, currentMediaItem, mediaRestored } from '../../signals/album.ts';
import type { MediaSelection } from '../../hooks/useMediaSelection.ts';
import type { TrashEntry, TrashPutResult } from '@ein/api';
import { notify } from '../../signals/notify.ts';
import { execCommand } from '../../signals/shell-client.ts';
import { shq } from '../../lib/shquote.ts';
import { archiveNameFromPaths, downloadOriginals } from '../../lib/download.ts';
import { forgetAspect } from '../../lib/aspect-cache.ts';
import { canWriteEach } from '../../lib/access.ts';
import { useAccessIds } from '../../hooks/useAccessIds.ts';
import { FavouriteAction } from './FavouriteAction.tsx';
import { SelectionActionButton, SelectionBarContext, type SelectionBarContextValue } from './SelectionActionButton.tsx';

/** Paths per `rm`. Keeps one failure local and the command line sane. */
const REMOVE_CHUNK = 50;

/**
 * What a component that owns a selection hands to the page supplying `actions`.
 *
 * Lives here rather than with either caller: the timeline and the search results both build one,
 * and neither should have to import the other to describe it.
 */
export type SelectionActionContext = {
  selection: MediaSelection;
  /** Everything loaded, in list order — the selection indexes into this. */
  items: MediaItem[];
  /** Re-run the query, for an action that changed how the media sorts. */
  reload: () => void;
};

type Props = {
  selection: MediaSelection;
  items: MediaItem[];
  /** Called with the media paths that left the list, so the page can drop them. */
  onRemoved: (paths: string[]) => void;
  /**
   * Extra controls for this selection, rendered between Download and Delete.
   *
   * Download and Delete are here because they mean the same thing wherever media is listed.
   * Anything that does not — setting a time, tagging a person, adding to an album — belongs to
   * the page, which knows the context it would act in. So the bar takes a slot rather than
   * growing a prop per feature: each caller passes a self-contained control (its own button and
   * whatever modal it needs), and the bar never learns what it does.
   */
  actions?: ReactNode;
  /**
   * Offer Delete. Off for a list whose items are renditions rather than media — a person's
   * face crops — where deleting one would leave a face without its picture and fix nothing.
   * Offered only when the reader may change every selected picture that lives here.
   */
  removable?: boolean;
  /** Name for a multi-file download, when the paths have no folder in common worth naming it by. */
  archiveName?: string;
};

/**
 * Actions for the current selection, floating over the grid.
 *
 * Mounted once by whoever owns the selection — a page, or the timeline — rather than by
 * each grid, since a timeline renders one grid per month over a single selection.
 */
export function MediaSelectionBar({ selection, items, onRemoved, actions, removable = true, archiveName }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const access = useAccessIds();
  // The same width the lightbox calls narrow: side by side, the buttons need about twice a
  // phone's width, so there they fold into one menu and the bar keeps to count, menu, clear.
  const narrow = useMediaQuery('(max-width: 48em)', false, { getInitialValueInEffect: false });
  const barContext = useMemo<SelectionBarContextValue>(() => ({ layout: narrow ? 'menu' : 'bar', reportError: setError }), [narrow]);

  if (selection.count === 0 && !busy) return null;

  const selectedItems = items.filter((item) => selection.selected.has(item.path));

  // What removing each selection actually acts on: the picture where it lives,
  // or — in an album that links its members — the link that files it here.
  // Deleting the target of one of those links would delete the picture everywhere.
  const members = selectedItems.filter((item) => item.memberPath);
  const owned = selectedItems.filter((item) => !item.memberPath);
  /** Nothing in the selection lives here, so nothing is destroyed by removing it. */
  const unfilingOnly = owned.length === 0 && members.length > 0;

  // No size warning: a selection of any size is one archive and one save prompt, so there
  // is nothing to warn about that the browser's own download does not already show.
  const handleDownload = async () => {
    setError(null);
    setBusy(true);
    try {
      // Named after the album when the selection shares one — a member is filed by its
      // link, so that is the path saying where these were picked from.
      await downloadOriginals(selectedItems, archiveName ?? archiveNameFromPaths(selectedItems.map((item) => item.memberPath ?? item.path)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Take the selection out of this list: a file that lives here goes to the reader's trash, a link
   * that only files a picture here is removed (the picture stays wherever it lives). Nothing is
   * lost, so nothing asks first; the toast's Undo restores the files and puts the links back.
   */
  const handleRemove = async () => {
    setError(null);
    setBusy(true);
    const trashed: TrashEntry[] = [];
    const unfiled: { path: string; link: string }[] = [];
    try {
      for (let i = 0; i < owned.length; i += REMOVE_CHUNK) {
        const chunk = owned.slice(i, i + REMOVE_CHUNK);
        const answer = await execCommand<TrashPutResult>(`trash put ${chunk.map((item) => shq(item.path)).join(' ')}`);
        trashed.push(...answer.entries);
      }
      for (let i = 0; i < members.length; i += REMOVE_CHUNK) {
        const chunk = members.slice(i, i + REMOVE_CHUNK);
        // -f keeps an already-gone link from failing the rest of the batch.
        await execCommand(`rm -f ${chunk.map((item) => shq(item.memberPath!)).join(' ')}`);
        unfiled.push(...chunk.map((item) => ({ path: item.path, link: item.memberPath! })));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }

    const gonePaths = [...trashed.map((entry) => entry.origPath), ...unfiled.map((entry) => entry.path)];
    if (gonePaths.length === 0) return;
    for (const entry of trashed) forgetAspect(entry.origPath);
    if (currentMediaItem.value && gonePaths.includes(currentMediaItem.value.path)) closeLightboxWithoutReturn();
    selection.remove(gonePaths);
    onRemoved(gonePaths);

    const parts = [
      trashed.length > 0 ? `${trashed.length} moved to the trash` : '',
      unfiled.length > 0 ? `${unfiled.length} taken out of this album` : '',
    ].filter(Boolean);
    notify({
      message: parts.join(', '),
      action: {
        label: 'Undo',
        onClick: async () => {
          try {
            if (trashed.length > 0) await execCommand(`trash restore ${trashed.map((entry) => shq(entry.id)).join(' ')}`);
            for (const entry of unfiled) await execCommand(`ln -s ${shq(entry.path)} ${shq(entry.link)}`);
            mediaRestored.value = { paths: gonePaths, at: Date.now() };
          } catch (err) {
            notify({ message: err instanceof Error ? err.message : String(err), color: 'red' });
          }
        },
      },
    });
  };

  // The same controls either way; `SelectionActionButton` reads the layout from context and
  // renders a button or a menu item accordingly.
  const controls = (
    <>
      <FavouriteAction selection={selection} />
      <SelectionActionButton icon={<IconDownload size={14} />} onClick={handleDownload} loading={busy}>
        Download
      </SelectionActionButton>
      {actions}
      {removable && canWriteEach(owned, access) && (
        <SelectionActionButton
          icon={unfilingOnly ? <IconLinkOff size={14} /> : <IconTrash size={14} />}
          color={unfilingOnly ? 'orange' : 'red'}
          onClick={handleRemove}
          disabled={busy}
        >
          {unfilingOnly ? 'Remove' : 'Delete'}
        </SelectionActionButton>
      )}
    </>
  );

  return (
    <>
      <ActionBar
        opened={selection.count > 0 || busy}
        onClose={selection.clear}
        aria-label='Media selection actions'
        shadow='xl'
        radius='md'
        bg='var(--mrx-surface-overlay)'
      >
        <Text size='sm' fw={500} style={{ whiteSpace: 'nowrap' }}>{selection.count} selected</Text>
        <ActionBar.Divider />
        {narrow
          ? (
            // The dropdown stays mounted so an action's dialog, which lives inside it,
            // survives the menu closing on the click that opened it. Hidden by `display: none`
            // rather than Mantine's default `<Activity>`, which would hold back every update to
            // the dialog — closing it or typing in it — while the menu is shut.
            <Menu position='top' shadow='md' keepMounted keepMountedMode='display-none' withinPortal>
              <Menu.Target>
                <Button size='xs' variant='light' rightSection={<IconChevronUp size={14} />} loading={busy}>
                  Actions
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <SelectionBarContext.Provider value={barContext}>{controls}</SelectionBarContext.Provider>
              </Menu.Dropdown>
            </Menu>
          )
          : <SelectionBarContext.Provider value={barContext}>{controls}</SelectionBarContext.Provider>}
        {error && <Text size='xs' c='red'>{error}</Text>}
        <ActionBar.Divider />
        <ActionBar.CloseButton aria-label='Clear selection' disabled={busy} />
      </ActionBar>
    </>
  );
}
