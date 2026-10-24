import { assertEquals, assertStrictEquals } from '@std/assert';
import {
  EMPTY_SECTION_SELECTION,
  isEmptySelection,
  isItemSelected,
  keepSections,
  selectAcross,
  selectedCount,
  selectSectionRange,
  setItems,
  setSections,
  toggleItem,
  toggleSection,
} from '../section-selection.ts';

const members: Record<string, number> = { a: 10, b: 20, c: 30, d: 40, e: 50, f: 60 };
const count = (section: string) => members[section];

Deno.test('a section toggles whole, and its items with it', () => {
  let selection = toggleItem(EMPTY_SECTION_SELECTION, '/a/1.jpg', 'a');
  selection = toggleSection(selection, 'a');
  assertEquals([...selection.sections], ['a']);
  assertEquals(selection.items.size, 0);
  assertEquals(isItemSelected(selection, '/a/1.jpg', 'a'), true);
  selection = toggleSection(selection, 'a');
  assertEquals(isEmptySelection(selection), true);
});

Deno.test('a range across five sections selects the three between whole', () => {
  const order = ['a', 'b', 'c', 'd', 'e', 'f'];
  const selection = selectSectionRange(EMPTY_SECTION_SELECTION, order, 'e', 'a');
  assertEquals([...selection.sections].sort(), ['a', 'b', 'c', 'd', 'e']);
  assertEquals(selectedCount(selection, count), 150);
  assertEquals(selectSectionRange(EMPTY_SECTION_SELECTION, order, 'a', 'z'), EMPTY_SECTION_SELECTION);
});

Deno.test('an item taken out of a whole section is an exclusion, and comes back', () => {
  let selection = toggleSection(EMPTY_SECTION_SELECTION, 'b');
  selection = toggleItem(selection, '/b/3.jpg', 'b');
  assertEquals([isItemSelected(selection, '/b/3.jpg', 'b'), isItemSelected(selection, '/b/4.jpg', 'b')], [false, true]);
  assertEquals(selectedCount(selection, count), 19);
  selection = toggleItem(selection, '/b/3.jpg', 'b');
  assertEquals([selection.excluded.size, selectedCount(selection, count)], [0, 20]);
});

Deno.test('items one by one count beside whole sections', () => {
  let selection = toggleSection(EMPTY_SECTION_SELECTION, 'a');
  selection = setItems(selection, 'c', ['/c/1.jpg', '/c/2.jpg'], true);
  assertEquals(selectedCount(selection, count), 12);
  assertEquals([isItemSelected(selection, '/c/1.jpg', 'c'), isItemSelected(selection, '/c/2.jpg', 'c')], [true, true]);
  selection = setItems(selection, 'c', ['/c/1.jpg'], false);
  assertEquals([isItemSelected(selection, '/c/1.jpg', 'c'), selectedCount(selection, count)], [false, 11]);
});

Deno.test('sections set whole drop what was selected of them one by one, and sections that left are forgotten', () => {
  let selection = setItems(EMPTY_SECTION_SELECTION, 'c', ['/c/1.jpg'], true);
  selection = setSections(selection, ['b', 'c'], true);
  assertEquals([[...selection.sections].sort(), selection.items.size], [['b', 'c'], 0]);
  selection = setItems(selection, 'c', ['/c/2.jpg'], false);
  selection = setItems(selection, 'd', ['/d/1.jpg'], true);
  const kept = keepSections(selection, (section) => section !== 'c');
  assertEquals([[...kept.sections], kept.excluded.size, kept.items.size], [['b'], 0, 1]);
  assertStrictEquals(keepSections(kept, () => true), kept);
});

/** The pictures of the sections laid out: only the open one. */
const itemsOf = (section: string) => section === 'c' ? ['/c/1.jpg', '/c/2.jpg', '/c/3.jpg', '/c/4.jpg'] : undefined;

Deno.test('a range from a picture to another section takes the rest of its own, those between whole and all of the last it does not know', () => {
  const order = ['a', 'b', 'c', 'd', 'e', 'f'];
  const selection = selectAcross(EMPTY_SECTION_SELECTION, order, { section: 'c', path: '/c/3.jpg' }, { section: 'f' }, itemsOf);
  assertEquals([...selection.sections].sort(), ['d', 'e', 'f']);
  assertEquals([...selection.items.keys()], ['/c/3.jpg', '/c/4.jpg']);
  assertEquals(selectedCount(selection, count), 152);
});

Deno.test('a range up to a picture takes the head of its section, either way round', () => {
  const order = ['a', 'b', 'c', 'd'];
  const down = selectAcross(EMPTY_SECTION_SELECTION, order, { section: 'a' }, { section: 'c', path: '/c/2.jpg' }, itemsOf);
  const up = selectAcross(EMPTY_SECTION_SELECTION, order, { section: 'c', path: '/c/2.jpg' }, { section: 'a' }, itemsOf);
  for (const selection of [down, up]) {
    assertEquals([...selection.sections].sort(), ['a', 'b']);
    assertEquals([...selection.items.keys()], ['/c/1.jpg', '/c/2.jpg']);
  }
});

Deno.test('a range within one section takes the pictures between', () => {
  const selection = selectAcross(EMPTY_SECTION_SELECTION, ['c'], { section: 'c', path: '/c/4.jpg' }, { section: 'c', path: '/c/2.jpg' }, itemsOf);
  assertEquals([...selection.items.keys()], ['/c/2.jpg', '/c/3.jpg', '/c/4.jpg']);
  assertEquals(selectAcross(EMPTY_SECTION_SELECTION, ['a'], { section: 'a' }, { section: 'z' }, itemsOf), EMPTY_SECTION_SELECTION);
});
