import { signal } from '@preact/signals-react';

/** Whether the finder's dialog is open: Mod+K opens it where the top bar's search box cannot be reached. */
export const paletteOpen = signal(false);

let headerInput: HTMLInputElement | null = null;

/** The top bar's search box says it is there (and, with null, that it is gone). */
export const setHeaderFinder = (input: HTMLInputElement | null): void => {
  headerInput = input;
};

/** The top bar's search box, if it is drawn and nothing lies over it: a dialog, the lightbox, a full-screen route. */
const reachableHeaderInput = (): HTMLInputElement | null => {
  if (!headerInput?.isConnected) return null;
  const box = headerInput.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return null;
  const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return top && (top === headerInput || headerInput.parentElement?.contains(top)) ? headerInput : null;
};

/** Mod+K: the top bar's search box when it can be reached, the same finder in a dialog where it cannot. */
export const openFinder = (): void => {
  const input = reachableHeaderInput();
  if (input) {
    input.focus();
    input.select();
    return;
  }
  paletteOpen.value = true;
};
