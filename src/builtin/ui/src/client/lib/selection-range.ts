/**
 * Shift-click range selection.
 *
 * Extends `base` — the selection as it stood when the anchor was set, not the current
 * one — with everything between the anchor and the clicked item. Using the snapshot is
 * what makes dragging a range back shrink it: re-running from the same base replaces the
 * previous span instead of leaving the items it used to cover stuck on.
 */
export function rangeSelect(
  base: ReadonlySet<string>,
  order: ReadonlyMap<string, number>,
  anchor: string | null,
  path: string,
): Set<string> {
  const next = new Set(base);

  const to = order.get(path);
  const from = anchor === null ? undefined : order.get(anchor);

  // No anchor, or either end has scrolled out of the list — treat it as a plain add.
  if (from === undefined || to === undefined) {
    next.add(path);
    return next;
  }

  const lo = Math.min(from, to);
  const hi = Math.max(from, to);

  for (const [candidate, index] of order) {
    if (index >= lo && index <= hi) next.add(candidate);
  }

  return next;
}
