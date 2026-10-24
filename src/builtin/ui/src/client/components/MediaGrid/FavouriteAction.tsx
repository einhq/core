import { useSignals } from '@preact/signals-react/runtime';
import { IconHeart, IconHeartOff } from '@tabler/icons-react';
import type { MediaSelection } from '../../hooks/useMediaSelection.ts';
import { notify } from '../../signals/notify.ts';
import { setStarred, starredPaths } from '../../signals/stars.ts';
import { isAuthenticated } from '../../signals/user.ts';
import { SelectionActionButton, useSelectionBar } from './SelectionActionButton.tsx';

/**
 * The selection bar's heart: adds the selected files to the reader's favourites, or takes them
 * out when every one of them is already there. A toast says so and offers Undo. The guest has no
 * favourites, which are kept in the reader's home, and no heart.
 */
export function FavouriteAction({ selection }: { selection: MediaSelection }) {
  useSignals();
  const { reportError } = useSelectionBar();
  const paths = selection.paths;
  const starred = starredPaths.value;
  const removing = paths.length > 0 && paths.every((path) => starred.has(path));

  const apply = async () => {
    const changed = paths.filter((path) => starred.has(path) === removing);
    reportError(null);
    try {
      await setStarred(changed, !removing);
      const what = `${changed.length} ${changed.length === 1 ? 'file' : 'files'}`;
      notify({
        message: removing ? `${what} taken out of favourites` : `${what} added to favourites`,
        action: { label: 'Undo', onClick: () => void setStarred(changed, removing).catch(() => {}) },
      });
    } catch (err) {
      reportError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!isAuthenticated.value) return null;
  return (
    <SelectionActionButton icon={removing ? <IconHeartOff size={14} /> : <IconHeart size={14} />} onClick={apply} disabled={paths.length === 0}>
      {removing ? 'Unfavourite' : 'Favourite'}
    </SelectionActionButton>
  );
}
