import { useCallback, useMemo, useRef, useState } from 'react';
import { rangeSelect } from '../lib/selection-range.ts';
import {
  EMPTY_SECTION_SELECTION,
  isEmptySelection,
  isItemSelected,
  keepSections,
  type SectionPoint,
  type SectionSelection,
  selectAcross,
  selectedCount,
  selectSectionRange,
  setItems,
  setSections,
  toggleItem,
  toggleSection,
} from '../lib/section-selection.ts';
import type { MediaSelection } from './useMediaSelection.ts';
import type { SelectionMods } from './useSelection.ts';

export type { SectionPoint, SectionSelection } from '../lib/section-selection.ts';

/** The stream a range crosses: its sections in order, and the items of those laid out. */
export type SectionOrder = { order: readonly string[]; itemsOf: (section: string) => readonly string[] | undefined };

export type SectionSelectionHandle = {
  selection: SectionSelection;
  /** Anything selected. */
  active: boolean;
  /** How many items are selected, from the sections' member counts. */
  count: (memberCount: (section: string) => number) => number;
  /** A section whole, or not at all; it becomes where a range starts. */
  toggleSection: (section: string) => void;
  /** Select every section from `from` to `to` of `order` whole. */
  selectRange: (order: readonly string[], from: string, to: string) => void;
  /** These sections whole, or none of them. */
  setSections: (sections: Iterable<string>, selected: boolean) => void;
  /**
   * Select from where the last range started (a section toggled, or an item clicked) to `to`,
   * across the sections between (`selectAcross`); with nothing to start from, from `start` (the
   * page's cursor), else `to` alone. Where it started stays where the next range starts.
   */
  extend: (stream: SectionOrder, to: SectionPoint, start?: SectionPoint) => void;
  /** Replace the selection: a lasso's, made from what was selected when it started. */
  set: (selection: SectionSelection) => void;
  /** Forget what lies in sections `keep` does not hold to (those that left the stream), and a range started in one. */
  keep: (keep: (section: string) => boolean) => void;
  clear: () => void;
  /**
   * The selection of one section's items as a media grid takes it, over `paths`, the section's
   * items in order: a click toggles one, shift extends from the last one clicked, mod+A takes them
   * all. Given the `stream`, a shift-click whose range started in another section selects across.
   */
  gridSelection: (section: string, paths: readonly string[], stream?: SectionOrder) => MediaSelection;
};

/**
 * A selection over a stream of sections (`lib/section-selection.ts`): sections whole, items of
 * them one by one, and items taken out of whole sections. No keys of its own: the page that holds
 * it has Escape and the rest bound to other things too.
 */
export function useSectionSelection(): SectionSelectionHandle {
  const [selection, setSelection] = useState<SectionSelection>(EMPTY_SECTION_SELECTION);
  const anchor = useRef<SectionPoint | null>(null);

  const clear = useCallback(() => {
    anchor.current = null;
    setSelection(EMPTY_SECTION_SELECTION);
  }, []);

  const extend = useCallback((stream: SectionOrder, to: SectionPoint, start?: SectionPoint) => {
    const from = anchor.current ?? start ?? to;
    anchor.current = from;
    setSelection((previous) => selectAcross(previous, stream.order, from, to, stream.itemsOf));
  }, []);

  const gridSelection = useCallback((section: string, paths: readonly string[], stream?: SectionOrder): MediaSelection => {
    const selected = new Set(paths.filter((path) => isItemSelected(selection, path, section)));
    const keys = paths.filter((path) => selected.has(path));
    const order = new Map(paths.map((path, index) => [path, index]));
    const set = (batch: readonly string[], on: boolean) => setSelection((previous) => setItems(previous, section, batch, on));
    return {
      selected,
      keys,
      paths: keys,
      count: keys.length,
      active: !isEmptySelection(selection),
      isSelected: (path) => selected.has(path),
      toggle: (path: string, mods: SelectionMods = {}) => {
        const from = anchor.current;
        if (mods.range && from !== null && from.section !== section && stream) {
          extend(stream, { section, path });
          return;
        }
        if (mods.range) set([...rangeSelect(new Set(), order, from?.section === section ? from.path ?? null : null, path)], true);
        else setSelection((previous) => toggleItem(previous, path, section));
        anchor.current = { section, path };
      },
      setKeys: (batch, on) => set(batch, on),
      selectAll: () => set(paths, true),
      clear,
      remove: (gone) => set(gone, false),
    };
  }, [selection, clear, extend]);

  return useMemo(() => ({
    selection,
    active: !isEmptySelection(selection),
    count: (memberCount: (section: string) => number) => selectedCount(selection, memberCount),
    toggleSection: (section: string) => {
      anchor.current = { section };
      setSelection((previous) => toggleSection(previous, section));
    },
    selectRange: (order: readonly string[], from: string, to: string) => setSelection((previous) => selectSectionRange(previous, order, from, to)),
    setSections: (sections: Iterable<string>, selected: boolean) => {
      const list = [...sections];
      setSelection((previous) => setSections(previous, list, selected));
    },
    extend,
    set: (next: SectionSelection) => setSelection(next),
    keep: (keep: (section: string) => boolean) => {
      if (anchor.current && !keep(anchor.current.section)) anchor.current = null;
      setSelection((previous) => keepSections(previous, keep));
    },
    clear,
    gridSelection,
  }), [selection, clear, extend, gridSelection]);
}
