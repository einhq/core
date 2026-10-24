/**
 * Giving a row of the explorer the keyboard without the browser's scrolling.
 *
 * `focus()` scrolls the element into view, and a details row is wider than a
 * half-screen pane: the listing would scroll sideways to the row's end, taking
 * the names off screen, on every click and every arrow key. The listing only
 * ever needs to scroll up or down, and only when the row is out of sight.
 */

/** Scroll the listing up or down just enough to show the row, below the sticky column header. */
export function revealRow(row: HTMLElement): void {
  const area = row.closest<HTMLElement>('[data-nodes-area]');
  if (!area) return;
  // The `li` holds the row's expanded subtree too; its first child is the row itself.
  const label = (row.firstElementChild as HTMLElement | null) ?? row;
  const box = label.getBoundingClientRect();
  const view = area.getBoundingClientRect();
  const top = view.top + (area.querySelector<HTMLElement>('[data-nodes-header]')?.offsetHeight ?? 0);
  if (box.top < top) area.scrollTop -= top - box.top;
  else if (box.bottom > view.bottom) area.scrollTop += box.bottom - view.bottom;
}

export function focusRow(row: HTMLElement | null | undefined): void {
  if (!row) return;
  row.focus({ preventScroll: true });
  revealRow(row);
}
