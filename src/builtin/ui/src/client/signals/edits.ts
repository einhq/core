import { signal } from '@preact/signals-react';

/**
 * A count of edits made from outside a page's own forms — a command run from a drawer while
 * what it changes is on screen. A page's own editor calls its `refetch` directly; the drawer
 * has no such handle, so pages that show editable data watch this and re-read when it moves.
 */
const outsideEdits = signal(0);

export const noteOutsideEdit = () => {
  outsideEdits.value++;
};

/** Call `onEdit` on each later edit, not for the current count. Returns the unsubscribe. */
export const onOutsideEdit = (onEdit: () => void): () => void => {
  let first = true;
  return outsideEdits.subscribe(() => {
    if (first) {
      first = false;
      return;
    }
    onEdit();
  });
};
