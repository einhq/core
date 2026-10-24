import { useCallback, useMemo, useRef, useState } from 'react';
import { rangeSelect } from '../lib/selection-range.ts';

export type SelectionMods = { range?: boolean; additive?: boolean };

export type Selection = {
  selected: ReadonlySet<string>;
  /** Selected keys in list order, pruned to what is currently on screen. */
  keys: string[];
  count: number;
  /** Anything selected — a plain click then toggles instead of doing its usual thing. */
  active: boolean;
  isSelected: (key: string) => boolean;
  toggle: (key: string, mods?: SelectionMods) => void;
  /** Select or deselect a whole run of keys at once, e.g. every photo of one day. */
  setKeys: (keys: string[], selected: boolean) => void;
  selectAll: () => void;
  clear: () => void;
  /** Forget specific keys, e.g. after they were deleted. */
  remove: (keys: string[]) => void;
};

/**
 * Multi-select over a flat list of keys.
 *
 * The mechanics only — a `Set`, a shift-range anchor, and the derived list. No hotkeys:
 * every page that uses this has something else bound to Escape (a lightbox, a modal), so
 * the guard belongs where that thing is known, not in here.
 */
export function useSelection(keys: string[]): Selection {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const anchorRef = useRef<string | null>(null);
  const baseRef = useRef<ReadonlySet<string>>(new Set());

  const order = useMemo(() => new Map(keys.map((key, index) => [key, index])), [keys]);

  // Derived, not stored: an item that dropped out of the result set drops out of the
  // action bar's count without anyone having to prune state on every refetch.
  const present = useMemo(() => keys.filter((key) => selected.has(key)), [keys, selected]);

  const clear = useCallback(() => {
    anchorRef.current = null;
    baseRef.current = new Set();
    setSelected(new Set());
  }, []);

  const selectAll = useCallback(() => {
    const all = new Set(keys);
    anchorRef.current = null;
    baseRef.current = all;
    setSelected(all);
  }, [keys]);

  const toggle = useCallback((key: string, mods: SelectionMods = {}) => {
    setSelected((prev) => {
      if (mods.range) {
        // The anchor stays put, so the range can be redrawn from the same start.
        return rangeSelect(baseRef.current, order, anchorRef.current, key);
      }

      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);

      anchorRef.current = key;
      baseRef.current = next;
      return next;
    });
  }, [order]);

  const setKeys = useCallback((batch: string[], select: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const key of batch) {
        if (select) next.add(key);
        else next.delete(key);
      }
      // A group is a block, not a click: it becomes the base a later shift-range
      // extends from, and it leaves no single anchor behind.
      anchorRef.current = null;
      baseRef.current = next;
      return next;
    });
  }, []);

  const remove = useCallback((gone: string[]) => {
    const drop = new Set(gone);
    setSelected((prev) => {
      const next = new Set([...prev].filter((key) => !drop.has(key)));
      baseRef.current = next;
      return next;
    });
    if (anchorRef.current !== null && drop.has(anchorRef.current)) anchorRef.current = null;
  }, []);

  return {
    selected,
    keys: present,
    count: present.length,
    active: present.length > 0,
    isSelected: useCallback((key: string) => selected.has(key), [selected]),
    toggle,
    setKeys,
    selectAll,
    clear,
    remove,
  };
}
