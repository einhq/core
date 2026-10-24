/**
 * A selection over a stream of sections, each a group of items, that never lists the items of a
 * whole section: a section is selected whole (`sections`), less any of its items taken out
 * (`excluded`), or by some of its items (`items`, each with its section). Toggles are O(1), a
 * range of sections selects the ones between whole, and the count comes from the sections' member
 * counts. Pure: `useSectionSelection` holds one.
 */

export type SectionSelection = {
  sections: ReadonlySet<string>;
  /** Items selected one by one, by path, each with the section it is in. */
  items: ReadonlyMap<string, string>;
  /** Items of a whole selected section taken out of it. */
  excluded: ReadonlyMap<string, string>;
};

export const EMPTY_SECTION_SELECTION: SectionSelection = { sections: new Set(), items: new Map(), excluded: new Map() };

const withoutSection = <K>(map: ReadonlyMap<K, string>, section: string): Map<K, string> => new Map([...map].filter(([, at]) => at !== section));

/** `section` selected whole, or not at all: either way, nothing of it is left selected or excluded one by one. */
export function toggleSection(selection: SectionSelection, section: string): SectionSelection {
  const sections = new Set(selection.sections);
  if (sections.has(section)) sections.delete(section);
  else sections.add(section);
  return { sections, items: withoutSection(selection.items, section), excluded: withoutSection(selection.excluded, section) };
}

/** Whether `path`, an item of `section`, is selected. */
export const isItemSelected = (selection: SectionSelection, path: string, section: string): boolean =>
  selection.sections.has(section) ? !selection.excluded.has(path) : selection.items.has(path);

/** `paths` of `section` selected or not. In a whole section that is an exclusion; elsewhere an item. */
export function setItems(selection: SectionSelection, section: string, paths: readonly string[], selected: boolean): SectionSelection {
  if (selection.sections.has(section)) {
    const excluded = new Map(selection.excluded);
    for (const path of paths) {
      if (selected) excluded.delete(path);
      else excluded.set(path, section);
    }
    return { ...selection, excluded };
  }
  const items = new Map(selection.items);
  for (const path of paths) {
    if (selected) items.set(path, section);
    else items.delete(path);
  }
  return { ...selection, items };
}

/** `path` of `section` the other way round. */
export const toggleItem = (selection: SectionSelection, path: string, section: string): SectionSelection =>
  setItems(selection, section, [path], !isItemSelected(selection, path, section));

/** Every section from `from` to `to` in `order`, both ends included, selected whole. */
export function selectSectionRange(selection: SectionSelection, order: readonly string[], from: string, to: string): SectionSelection {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a < 0 || b < 0) return selection;
  let next = selection;
  for (const section of order.slice(Math.min(a, b), Math.max(a, b) + 1)) {
    if (!next.sections.has(section)) next = toggleSection(next, section);
  }
  return next;
}

/** How many items are selected, from each whole section's `memberCount`, without listing any. */
export const selectedCount = (selection: SectionSelection, memberCount: (section: string) => number): number =>
  [...selection.sections].reduce((sum, section) => sum + memberCount(section), 0) - selection.excluded.size + selection.items.size;

/** Whether nothing is selected. */
export const isEmptySelection = (selection: SectionSelection): boolean => selection.sections.size === 0 && selection.items.size === 0;

/** `sections` selected whole, or not at all: either way, nothing of them is left selected or excluded one by one. */
export function setSections(selection: SectionSelection, sections: Iterable<string>, selected: boolean): SectionSelection {
  const next = new Set(selection.sections);
  const touched = new Set(sections);
  for (const section of touched) {
    if (selected) next.add(section);
    else next.delete(section);
  }
  const keep = <K>(map: ReadonlyMap<K, string>) => new Map([...map].filter(([, at]) => !touched.has(at)));
  return { sections: next, items: keep(selection.items), excluded: keep(selection.excluded) };
}

/** Only what lies in the sections `keep` holds to: a section that left the stream takes its items and exclusions with it. */
export function keepSections(selection: SectionSelection, keep: (section: string) => boolean): SectionSelection {
  const sections = [...selection.sections].filter(keep);
  const items = [...selection.items].filter(([, at]) => keep(at));
  const excluded = [...selection.excluded].filter(([, at]) => keep(at));
  if (sections.length === selection.sections.size && items.length === selection.items.size && excluded.length === selection.excluded.size) return selection;
  return { sections: new Set(sections), items: new Map(items), excluded: new Map(excluded) };
}

/** One end of a range across sections: a section, and an item of it when the range starts or stops at one. */
export type SectionPoint = { section: string; path?: string };

/**
 * Everything from `from` to `to` selected, across the sections of `order`: the rest of the first
 * section from `from`'s item, every section between whole, and the head of the last up to `to`'s
 * item. A section whose items `itemsOf` does not know (it is not laid out), or an end without an
 * item, is taken whole; within one section it is the items between the two. Either way round.
 */
export function selectAcross(
  selection: SectionSelection,
  order: readonly string[],
  from: SectionPoint,
  to: SectionPoint,
  itemsOf: (section: string) => readonly string[] | undefined,
): SectionSelection {
  let a = order.indexOf(from.section);
  let b = order.indexOf(to.section);
  if (a < 0 || b < 0) return selection;
  let [start, end] = [from, to];
  if (a > b) {
    [start, end] = [to, from];
    [a, b] = [b, a];
  }
  // The items of `point`'s section from its item on (`tail`) or up to it, or none when it is taken whole.
  const part = (point: SectionPoint, tail: boolean, until?: string): string[] | undefined => {
    const items = itemsOf(point.section);
    const at = point.path === undefined || !items ? -1 : items.indexOf(point.path);
    if (!items || at < 0) return undefined;
    if (until !== undefined) {
      const other = items.indexOf(until);
      if (other < 0) return undefined;
      return items.slice(Math.min(at, other), Math.max(at, other) + 1);
    }
    return tail ? items.slice(at) : items.slice(0, at + 1);
  };
  let next = selection;
  const take = (section: string, items: string[] | undefined) => {
    if (items === undefined) next = next.sections.has(section) ? next : setSections(next, [section], true);
    else next = setItems(next, section, items, true);
  };
  if (a === b) {
    take(start.section, start.path !== undefined && end.path !== undefined ? part(start, true, end.path) : undefined);
    return next;
  }
  take(start.section, part(start, true));
  for (const section of order.slice(a + 1, b)) take(section, undefined);
  take(end.section, part(end, false));
  return next;
}
