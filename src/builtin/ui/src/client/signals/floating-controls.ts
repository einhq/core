import { signal } from '@preact/signals-react';

/** Whether a page header's controls float over the page's foot (`FloatingControls`), which back to top stands beside. */
export const floatingControlsShown = signal(false);

/** Whether their box has the keyboard and the whole row with it, which back to top gives up. */
export const floatingControlsTyping = signal(false);
